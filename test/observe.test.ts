import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { EnforceBlockedError, EnforceClient, EnforceOutcomeUnknownError, ObserveClient } from '../src/index.js';
import type { ObserveOperation } from '../src/index.js';

type RequestBody = {
  requestId: string;
  phase: 'tool_call' | 'tool_result';
  attribution: Record<string, unknown>;
  identityProof: { issuedAt: number; expiresAt: number; signature: string };
};

function requestBody(init: RequestInit | undefined): RequestBody {
  return JSON.parse(String(init?.body)) as RequestBody;
}

const organisationId = '00000000-0000-4000-8000-000000000001';
const deploymentId = '00000000-0000-4000-8000-000000000002';
const operationVersionId = '00000000-0000-4000-8000-000000000003';
const adapterToken = 'abcdefghijklmnopqrstuvwxyz012345';
const keys = generateKeyPairSync('ed25519');

function operation(): ObserveOperation {
  return {
    operationVersionId,
    actionKey: 'invoice-123',
    principalId: 'staff_123',
    sessionId: 'task_123',
    resourceId: 'invoice_123',
    principalSource: 'application_session',
    resourceSource: 'application_lookup',
  };
}

function client(fetchImpl: typeof fetch) {
  return new ObserveClient({
    sidecarUrl: 'http://127.0.0.1:7078',
    adapterToken,
    organisationId,
    deploymentId,
    executorPrivateKey: keys.privateKey,
    fetch: fetchImpl,
  });
}

function enforceClient(fetchImpl: typeof fetch) {
  return new EnforceClient({ sidecarUrl: 'http://127.0.0.1:7078', adapterToken,
    organisationId, deploymentId, executorPrivateKey: keys.privateKey, fetch: fetchImpl });
}

test('Enforce runs only after a retained allow and checks the result before exposure', async () => {
  const phases: string[] = [];
  const adapter = enforceClient(async (_url, init) => {
    const body = requestBody(init);
    phases.push(body.phase);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: false }),
      { status: 200 });
  });
  let effects = 0;
  const completed = await adapter.enforce(operation(), { invoiceId: 'invoice_123' }, () => {
    effects++;
    return { status: 'paid' };
  });
  assert.equal(effects, 1);
  assert.deepEqual(phases, ['tool_call', 'tool_result']);
  assert.deepEqual(completed.result, { status: 'paid' });
});

test('Enforce stops denied or unrecorded calls and withholds denied results', async () => {
  let outcome = 'deny';
  let recordingStatus = 'retained';
  const adapter = enforceClient(async (_url, init) => {
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome, recordingStatus,
      reportReplayed: false }), { status: 200 });
  });
  let effects = 0;
  const effect = () => { effects++; return { secret: 'private' }; };
  await assert.rejects(adapter.enforce(operation(), {}, effect), (error) =>
    error instanceof EnforceBlockedError && error.phase === 'tool_call' &&
    !error.effectMayHaveOccurred);
  assert.equal(effects, 0);
  outcome = 'allow';
  recordingStatus = 'queued';
  await assert.rejects(adapter.enforce(operation(), {}, effect), EnforceBlockedError);
  assert.equal(effects, 0);
  recordingStatus = 'retained';
  const replayed = enforceClient(async (_url, init) => {
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: true }), { status: 200 });
  });
  await assert.rejects(replayed.enforce(operation(), {}, effect), EnforceBlockedError);
  assert.equal(effects, 0);
  let checks = 0;
  const resultAdapter = enforceClient(async (_url, init) => {
    const body = requestBody(init);
    checks++;
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated',
      outcome: checks === 1 ? 'allow' : 'deny', recordingStatus: 'retained',
      reportReplayed: false }), { status: 200 });
  });
  await assert.rejects(resultAdapter.enforce(operation(), {}, effect), (error) =>
    error instanceof EnforceBlockedError && error.phase === 'tool_result' &&
    error.effectMayHaveOccurred);
  assert.equal(effects, 1);
});

test('Enforce preserves an uncertain tool outcome for reconciliation', async () => {
  const adapter = enforceClient(async (_url, init) => {
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: false }), { status: 200 });
  });
  await assert.rejects(adapter.enforce(operation(), {}, () => {
    throw new Error('provider timed out');
  }), EnforceOutcomeUnknownError);
});

function expectedStatement(body: RequestBody, inputSha256: string) {
  return JSON.stringify({
    type: 'authrail.observe.executor.v1',
    organisationId,
    deploymentId,
    requestId: body.requestId,
    actionKey: 'invoice-123',
    operationVersionId,
    phase: body.phase,
    inputSha256,
    attribution: body.attribution,
    issuedAt: body.identityProof.issuedAt,
    expiresAt: body.identityProof.expiresAt,
  });
}

test('Observe signs both phases without delaying the protected function', async () => {
  let releaseCall: () => void = () => {};
  const callGate = new Promise<void>((resolve) => {
    releaseCall = resolve;
  });
  const phases: string[] = [];
  const requests: RequestBody[] = [];
  const adapter = client(async (_url, init) => {
    const body = requestBody(init);
    phases.push(body.phase);
    requests.push(body);
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'invoice-123');
    assert.equal(init?.redirect, 'manual');
    const input =
      body.phase === 'tool_call'
        ? '{"arguments":{"amount":50,"invoiceId":"invoice_123"}}'
        : '{"arguments":{"amount":50,"invoiceId":"invoice_123"},"result":{"status":"paid"}}';
    const digest = createHash('sha256').update(input).digest('hex');
    assert.equal(
      verify(
        null,
        Buffer.from(expectedStatement(body, digest)),
        keys.publicKey,
        Buffer.from(body.identityProof.signature, 'base64url'),
      ),
      true,
    );
    if (body.phase === 'tool_call') await callGate;
    return new Response(
      JSON.stringify({
        requestId: body.requestId,
        mode: 'observe',
        enforced: false,
        coverage: 'evaluated',
        outcome: 'allow',
        recordingStatus: 'retained',
      }),
      { status: 200 },
    );
  });
  let executions = 0;
  const observed = adapter.observe(operation(), { invoiceId: 'invoice_123', amount: 50 }, () => {
    executions++;
    return { status: 'paid' };
  });
  assert.deepEqual(await observed.result, { status: 'paid' });
  assert.equal(executions, 1);
  assert.deepEqual(phases, ['tool_call']);
  releaseCall();
  const checks = await observed.observation;
  assert.deepEqual(phases, ['tool_call', 'tool_result']);
  assert.ok(requests[0] && requests[1]);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(checks.callDecision?.outcome, 'allow');
  assert.equal(checks.resultDecision?.outcome, 'allow');
  assert.equal(checks.callError, null);
});

test('invalid context and sidecar failure remain advisory', async () => {
  const adapter = client(async () => {
    throw new Error('sidecar offline');
  });
  const invalid = adapter.observe({ ...operation(), principalId: 'invalid id' }, {}, () => 'ran');
  assert.equal(await invalid.result, 'ran');
  const invalidChecks = await invalid.observation;
  assert.match(String(invalidChecks.callError), /invalid/);
  assert.equal(invalidChecks.resultError, invalidChecks.callError);
  const unavailable = adapter.observe(operation(), { invoiceId: 'invoice_123' }, () => ({
    ok: true,
  }));
  assert.deepEqual(await unavailable.result, { ok: true });
  const checks = await unavailable.observation;
  assert.match(String(checks.callError), /offline/);
  assert.match(String(checks.resultError), /offline/);
});

test('tool failure keeps the tool error and does not invent a result hook', async () => {
  const phases: string[] = [];
  const adapter = client(async (_url, init) => {
    const body = requestBody(init);
    phases.push(body.phase);
    return new Response(
      JSON.stringify({
        requestId: body.requestId,
        mode: 'observe',
        enforced: false,
        coverage: 'evaluated',
        outcome: 'deny',
      }),
      { status: 200 },
    );
  });
  const failure = new Error('provider failed');
  const observed = adapter.observe(operation(), { invoiceId: 'invoice_123' }, () => {
    throw failure;
  });
  await assert.rejects(observed.result, (error) => error === failure);
  const checks = await observed.observation;
  assert.deepEqual(phases, ['tool_call']);
  assert.equal(checks.callDecision?.outcome, 'deny');
  assert.match(String(checks.resultError), /tool error/i);
});

test('Observe refuses non-loopback sidecar endpoints', () => {
  assert.throws(
    () =>
      new ObserveClient({
        sidecarUrl: 'https://authrail.example.com',
        adapterToken,
        organisationId,
        deploymentId,
        executorPrivateKey: keys.privateKey,
      }),
    /invalid/,
  );
});

test('signed context covers reviewed facts and same-session trajectory', async () => {
  const sourceVersionId = '00000000-0000-4000-8000-000000000004';
  const observedAt = '2026-10-20T00:00:00Z';
  const seen: RequestBody[] = [];
  const adapter = client(async (_url, init) => {
    const body = requestBody(init);
    seen.push(body);
    const input = `{"arguments":{"invoiceId":"in_1234"},"factResolutions":[{"sourceVersionId":"${sourceVersionId}","providerAccountId":"acct_12345678","lookup":"invoice.retrieve","lookupKey":"in_1234","authenticatedExecutor":true,"status":"ok","observedAt":"${observedAt}","value":{"status":"paid"}}],"trajectory":{"sessionId":"task_123","start":true,"complete":true,"priorReadOperationVersionIds":[],"values":{"reviewed":true}}}`;
    const expected =
      body.phase === 'tool_call'
        ? input
        : input.replace(
            '"arguments":{"invoiceId":"in_1234"}',
            '"arguments":{"invoiceId":"in_1234"},"result":{"paid":true}',
          );
    const digest = createHash('sha256').update(expected).digest('hex');
    assert.equal(
      verify(
        null,
        Buffer.from(expectedStatement(body, digest)),
        keys.publicKey,
        Buffer.from(body.identityProof.signature, 'base64url'),
      ),
      true,
    );
    return new Response(
      JSON.stringify({
        requestId: body.requestId,
        mode: 'observe',
        enforced: false,
        coverage: 'evaluated',
        outcome: 'allow',
      }),
      { status: 200 },
    );
  });
  const observed = adapter.observe(
    {
      ...operation(),
      factResolutions: [
        {
          sourceVersionId,
          providerAccountId: 'acct_12345678',
          lookup: 'invoice.retrieve',
          lookupKey: 'in_1234',
          authenticatedExecutor: true,
          status: 'ok',
          observedAt,
          value: { status: 'paid' },
        },
      ],
      trajectory: {
        sessionId: 'task_123',
        start: true,
        complete: true,
        priorReadOperationVersionIds: [],
        values: { reviewed: true },
      },
    },
    { invoiceId: 'in_1234' },
    () => ({ paid: true }),
  );
  assert.deepEqual(await observed.result, { paid: true });
  assert.equal((await observed.observation).resultError, null);
  assert.deepEqual(
    seen.map((entry) => entry.phase),
    ['tool_call', 'tool_result'],
  );
});

test('invalid sidecar response is a coverage gap, not a tool denial', async () => {
  const adapter = client(
    async () =>
      new Response(
        JSON.stringify({
          requestId: randomUUID(),
          mode: 'enforce',
          enforced: true,
          coverage: 'evaluated',
          outcome: 'deny',
        }),
        { status: 200 },
      ),
  );
  const observed = adapter.observe(operation(), {}, () => ({ stillRan: true }));
  assert.deepEqual(await observed.result, { stillRan: true });
  const checks = await observed.observation;
  assert.match(String(checks.callError), /contract/);
  assert.match(String(checks.resultError), /contract/);
});

test('real loopback HTTP sends authenticated, signed call and result requests', async () => {
  const requests: RequestBody[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
    requests.push(body);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/evaluate');
    assert.equal(request.headers.authorization, `Bearer ${adapterToken}`);
    assert.equal(request.headers['idempotency-key'], 'invoice-123');
    const input =
      body.phase === 'tool_call'
        ? '{"arguments":{"invoiceId":"invoice_123"}}'
        : '{"arguments":{"invoiceId":"invoice_123"},"result":{"ok":true}}';
    const digest = createHash('sha256').update(input).digest('hex');
    assert.equal(
      verify(
        null,
        Buffer.from(expectedStatement(body, digest)),
        keys.publicKey,
        Buffer.from(body.identityProof.signature, 'base64url'),
      ),
      true,
    );
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        requestId: body.requestId,
        mode: 'observe',
        enforced: false,
        coverage: 'evaluated',
        outcome: 'allow',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const adapter = new ObserveClient({
      sidecarUrl: `http://127.0.0.1:${address.port}`,
      adapterToken,
      organisationId,
      deploymentId,
      executorPrivateKey: keys.privateKey,
    });
    const observed = adapter.observe(operation(), { invoiceId: 'invoice_123' }, () => ({
      ok: true,
    }));
    assert.deepEqual(await observed.result, { ok: true });
    const checks = await observed.observation;
    assert.equal(checks.callError, null);
    assert.equal(checks.resultError, null);
    assert.deepEqual(
      requests.map((entry) => entry.phase),
      ['tool_call', 'tool_result'],
    );
    assert.ok(requests[0] && requests[1]);
    assert.equal(requests[0].requestId, requests[1].requestId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
