import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { EnforceBlockedError, EnforceClient, EnforceOutcomeUnknownError, ObserveClient } from '../src/index.js';
import type { ObserveOperation } from '../src/index.js';
import { encodeInput } from '../src/observe/protocol.js';
import type { ObservedCall } from '../src/observe/protocol.js';

type RequestBody = {
  requestId: string;
  phase: 'tool_call' | 'tool_result';
  attribution: Record<string, unknown>;
  identityProof: { issuedAt: number; expiresAt: number; signature: string };
  reviewSummary?: { title: string; fields: Array<{ label: string; value: string }> };
};

function requestBody(init: RequestInit | undefined): RequestBody {
  return JSON.parse(String(init?.body)) as RequestBody;
}

const organisationId = '00000000-0000-4000-8000-000000000001';
const deploymentId = '00000000-0000-4000-8000-000000000002';
const operationVersionId = '00000000-0000-4000-8000-000000000003';
const adapterToken = 'abcdefghijklmnopqrstuvwxyz012345';
const keys = generateKeyPairSync('ed25519');
const actionId = '00000000-0000-4000-8000-000000000004';

function receiptResponse(init: RequestInit | undefined, events?: string[]): Response {
  const body = JSON.parse(String(init?.body)) as { actionId: string; attemptId: string;
    permitId: string | null; event: string; inputSha256: string;
    providerIdempotencyKey: string; providerReference: string | null;
    keySha256: string; proof: { issuedAt: number; expiresAt: number; signature: string } };
  assert.equal(body.actionId, actionId);
  assert.equal(body.providerIdempotencyKey, `ar-${actionId}`);
  const statement = JSON.stringify({ type: 'authrail.execution.receipt.v1',
    organisationId, deploymentId, actionId: body.actionId,
    attemptId: body.attemptId, permitId: body.permitId, event: body.event,
    inputSha256: body.inputSha256,
    providerIdempotencyKey: body.providerIdempotencyKey,
    providerReference: body.providerReference, keySha256: body.keySha256,
    issuedAt: body.proof.issuedAt, expiresAt: body.proof.expiresAt });
  assert.equal(verify(null, Buffer.from(statement), keys.publicKey,
    Buffer.from(body.proof.signature, 'base64url')), true);
  events?.push(body.event);
  return new Response(JSON.stringify({ receiptId: randomUUID(),
    state: body.event === 'started' ? 'executing' :
      body.event === 'unknown' ? 'outcome_unknown' : 'succeeded', replayed: false }),
  { status: 201 });
}

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

test('shared decision conformance fixtures gate protected effects', async () => {
  const corpus = JSON.parse(readFileSync('conformance/v1/decision-cases.json', 'utf8')) as {
    formatVersion: number;
    cases: Array<{ name: string; mode: string; coverage: string; outcome: string;
      recordingStatus: string; reportReplayed?: boolean; effectRuns: boolean }> };
  assert.equal(corpus.formatVersion, 1);
  for (const fixture of corpus.cases) {
    let effects = 0;
    const adapter = enforceClient(async (url, init) => {
      if (new URL(String(url)).pathname === '/execution-receipts') return receiptResponse(init);
      const body = requestBody(init);
      return new Response(JSON.stringify({ requestId: body.requestId, mode: fixture.mode,
        enforced: false, coverage: fixture.coverage, outcome: fixture.outcome,
        recordingStatus: fixture.recordingStatus,
        ...(fixture.reportReplayed !== undefined ? { reportReplayed: fixture.reportReplayed } : {}),
        actionId }), { status: 200 });
    });
    try { await adapter.enforce(operation(), {}, () => { effects++; return {}; }); }
    catch { /* blocked cases must not run the protected callback */ }
    assert.equal(effects === 1, fixture.effectRuns, fixture.name);
  }
});

test('shared canonical input vectors match the signed Node bytes', () => {
  const corpus = JSON.parse(readFileSync('conformance/v1/canonical-input.json', 'utf8')) as {
    formatVersion: number;
    cases: Array<{ name: string; phase: 'tool_call' | 'tool_result';
      arguments: Record<string, string | number>; result?: Record<string, string>;
      factResolutions?: ObservedCall['factResolutions'];
      trajectory?: ObservedCall['trajectory']; canonicalInput: string }> };
  assert.equal(corpus.formatVersion, 1);
  for (const fixture of corpus.cases) {
    const call = { ...operation(), requestId: randomUUID(), arguments: fixture.arguments,
      factResolutions: fixture.factResolutions, trajectory: fixture.trajectory } as ObservedCall;
    assert.equal(encodeInput(call, fixture.phase, fixture.result),
      fixture.canonicalInput, fixture.name);
  }
});

test('shared failure fixtures keep effects and result exposure distinct', async () => {
  const corpus = JSON.parse(readFileSync('conformance/v1/failure-cases.json', 'utf8')) as {
    formatVersion: number;
    cases: Array<{ name: string; stage: string; effectRuns: boolean;
      error: 'blocked_call' | 'outcome_unknown' | 'blocked_result' }> };
  assert.equal(corpus.formatVersion, 1);
  for (const fixture of corpus.cases) {
    let effects = 0;
    const adapter = enforceClient(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/evaluate') {
        if (fixture.stage === 'decision_unavailable') throw new Error('offline');
        const body = requestBody(init);
        if (fixture.stage === 'decision_malformed') return new Response('{}');
        if (body.phase === 'tool_result' && fixture.stage === 'result_unavailable')
          return new Response('', { status: 503 });
        return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
          enforced: false, coverage: 'evaluated',
          outcome: body.phase === 'tool_result' && fixture.stage === 'result_denied'
            ? 'deny' : 'allow', recordingStatus: 'retained',
          reportReplayed: false, actionId }), { status: 200 });
      }
      const receipt = JSON.parse(String(init?.body)) as { event: string };
      if (receipt.event === 'started' && fixture.stage === 'start_unavailable')
        return new Response('', { status: 503 });
      if (receipt.event === 'succeeded' && fixture.stage === 'completion_unavailable')
        return new Response('', { status: 503 });
      if (receipt.event === 'started' && fixture.stage === 'start_replayed')
        return new Response(JSON.stringify({ receiptId: randomUUID(), state: 'executing',
          replayed: true }), { status: 201 });
      return receiptResponse(init);
    });
    let caught: unknown;
    try {
      await adapter.enforce(operation(), {}, () => {
        effects++;
        if (fixture.stage === 'provider_unknown') throw new Error('provider timeout');
        return { ok: true };
      });
    } catch (error) { caught = error; }
    assert.equal(effects === 1, fixture.effectRuns, fixture.name);
    if (fixture.error === 'outcome_unknown') {
      assert.ok(caught instanceof EnforceOutcomeUnknownError, fixture.name);
    } else {
      assert.ok(caught instanceof EnforceBlockedError, fixture.name);
      assert.equal(caught.phase, fixture.error === 'blocked_call' ? 'tool_call' : 'tool_result',
        fixture.name);
      assert.equal(caught.effectMayHaveOccurred, fixture.error === 'blocked_result', fixture.name);
    }
  }
});

test('Enforce runs only after a retained allow and checks the result before exposure', async () => {
  const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const phases: string[] = [];
  let callRequestId: string | undefined;
  const adapter = enforceClient(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('traceparent'), traceparent);
    if (new URL(String(_url)).pathname === '/execution-receipts') {
      const receipt = JSON.parse(String(init?.body)) as { attemptId: string };
      assert.equal(receipt.attemptId, callRequestId);
      return receiptResponse(init, phases);
    }
    const body = requestBody(init);
    if (body.phase === 'tool_call') callRequestId = body.requestId;
    phases.push(body.phase);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: false, actionId }),
      { status: 200 });
  });
  let effects = 0;
  const completed = await adapter.enforce({ ...operation(), traceparent }, { invoiceId: 'invoice_123' }, () => {
    effects++;
    return { status: 'paid' };
  });
  assert.equal(effects, 1);
  assert.deepEqual(phases, ['tool_call', 'started', 'succeeded', 'tool_result']);
  assert.deepEqual(completed.result, { status: 'paid' });
});

test('Enforce signs the bounded human summary only on the call', async () => {
  let checked = 0;
  const adapter = enforceClient(async (_url, init) => {
    if (new URL(String(_url)).pathname === '/execution-receipts') return receiptResponse(init);
    const body = requestBody(init);
    if (body.phase === 'tool_call') {
      assert.equal(body.reviewSummary?.title, 'Pay invoice');
      const digest = createHash('sha256').update(JSON.stringify({ title: body.reviewSummary?.title,
        fields: body.reviewSummary?.fields.map(({ label, value }) => ({ label, value })) })).digest('hex');
      const statement = JSON.stringify({ type: 'authrail.observe.executor.v1',
        organisationId, deploymentId, requestId: body.requestId,
        actionKey: 'invoice-123', operationVersionId, phase: 'tool_call',
        inputSha256: createHash('sha256').update('{"arguments":{"amount":400}}').digest('hex'),
        attribution: body.attribution, reviewSummarySha256: digest,
        issuedAt: body.identityProof.issuedAt, expiresAt: body.identityProof.expiresAt });
      assert.equal(verify(null, Buffer.from(statement), keys.publicKey,
        Buffer.from(body.identityProof.signature, 'base64url')), true);
    } else assert.equal(body.reviewSummary, undefined);
    checked++;
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: false, actionId }), { status: 200 });
  });
  await adapter.enforce({ ...operation(), reviewSummary: { title: 'Pay invoice',
    fields: [{ label: 'Amount', value: '400' }] } }, { amount: 400 }, () => ({ paid: true }));
  assert.equal(checked, 2);
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
    if (new URL(String(_url)).pathname === '/execution-receipts') return receiptResponse(init);
    const body = requestBody(init);
    checks++;
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated',
      outcome: checks === 1 ? 'allow' : 'deny', recordingStatus: 'retained',
      reportReplayed: false, actionId }), { status: 200 });
  });
  await assert.rejects(resultAdapter.enforce(operation(), {}, effect), (error) =>
    error instanceof EnforceBlockedError && error.phase === 'tool_result' &&
    error.effectMayHaveOccurred);
  assert.equal(effects, 1);
});

test('Enforce does not run the protected call while the sidecar is offline', async () => {
  const adapter = enforceClient(async () => { throw new Error('sidecar offline'); });
  let effects = 0;
  await assert.rejects(adapter.enforce(operation(), {}, () => {
    effects++;
    return { paid: true };
  }), (error) => error instanceof EnforceBlockedError &&
    error.phase === 'tool_call' && !error.effectMayHaveOccurred);
  assert.equal(effects, 0);
});

test('Enforce preserves an uncertain tool outcome for reconciliation', async () => {
  const events: string[] = [];
  const adapter = enforceClient(async (_url, init) => {
    if (new URL(String(_url)).pathname === '/execution-receipts') return receiptResponse(init, events);
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: false, actionId }), { status: 200 });
  });
  await assert.rejects(adapter.enforce(operation(), {}, () => {
    throw new Error('provider timed out');
  }), (error) => error instanceof EnforceOutcomeUnknownError &&
    error.recovery?.actionId === actionId &&
    error.recovery.providerIdempotencyKey === `ar-${actionId}`);
  assert.deepEqual(events, ['started', 'unknown']);
});

test('Enforce does not call the provider when the start receipt is uncertain', async () => {
  let effects = 0;
  const adapter = enforceClient(async (url, init) => {
    if (new URL(String(url)).pathname === '/execution-receipts') {
      throw new Error('receipt response lost');
    }
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'allow',
      recordingStatus: 'retained', reportReplayed: false, actionId }), { status: 200 });
  });
  await assert.rejects(adapter.enforce(operation(), {}, () => {
    effects++; return { paid: true };
  }), (error) => error instanceof EnforceBlockedError &&
    error.phase === 'tool_call' && !error.effectMayHaveOccurred);
  assert.equal(effects, 0);
});

test('reconciliation signs the caller-reported provider outcome without rerunning the function', async () => {
  const events: string[] = [];
  const adapter = enforceClient(async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/execution-receipts');
    assert.equal(new Headers(init?.headers).get('Idempotency-Key')?.endsWith(
      ':reconciled_succeeded'), true);
    return receiptResponse(init, events);
  });
  const result = await adapter.reconcile({ actionId, attemptId: randomUUID(),
    permitId: null, inputSha256: 'a'.repeat(64),
    providerIdempotencyKey: `ar-${actionId}`,
    providerReference: 'provider-payment-123', outcome: 'succeeded' });
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(events, ['reconciled_succeeded']);
});

test('approval resumes the original call only after a one-use claim', async () => {
  const approvalRequestId = randomUUID();
  const permitId = randomUUID();
  const requests: string[] = [];
  const adapter = enforceClient(async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === '/execution-receipts') return receiptResponse(init);
    if (path === '/approval-permits/claim') {
      const claim = JSON.parse(String(init?.body)) as { actionId: string;
        approvalRequestId: string; proof: { signature: string; issuedAt: number;
          expiresAt: number }; inputSha256: string; keySha256: string };
      assert.equal(claim.actionId, actionId);
      assert.equal(claim.approvalRequestId, approvalRequestId);
      const statement = JSON.stringify({ type: 'authrail.approval.claim.v1',
        organisationId, deploymentId, approvalRequestId, actionId,
        inputSha256: claim.inputSha256, keySha256: claim.keySha256,
        issuedAt: claim.proof.issuedAt, expiresAt: claim.proof.expiresAt });
      assert.equal(verify(null, Buffer.from(statement), keys.publicKey,
        Buffer.from(claim.proof.signature, 'base64url')), true);
      return new Response(JSON.stringify({ permitId, actionId,
        expiresAt: new Date(Date.now() + 20_000).toISOString() }), { status: 201 });
    }
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: body.phase === 'tool_call'
        ? 'approval_required' : 'allow', recordingStatus: 'retained', reportReplayed: false,
      ...(body.phase === 'tool_call' ? { actionId, approvalRequestId } : {}) }),
    { status: 200 });
  });
  let blocked: EnforceBlockedError | undefined;
  let effects = 0;
  try { await adapter.enforce(operation(), { amount: 400 }, () => {
    effects++;
    return { paid: true };
  }); } catch (error) {
    if (error instanceof EnforceBlockedError) blocked = error;
    else throw error;
  }
  assert.ok(blocked);
  assert.equal(effects, 0);
  const resumed = await adapter.resumeApproval(blocked);
  assert.equal(resumed.permitId, permitId);
  assert.equal(effects, 1);
  assert.deepEqual(requests, ['/evaluate', '/approval-permits/claim',
    '/execution-receipts', '/execution-receipts', '/evaluate']);
  await assert.rejects(adapter.resumeApproval(blocked), EnforceBlockedError);
  assert.equal(effects, 1);
});

test('an uncertain approval claim never runs or retries the protected callback', async () => {
  let claims = 0;
  const adapter = enforceClient(async (url, init) => {
    if (new URL(String(url)).pathname === '/approval-permits/claim') {
      claims++;
      throw new Error('response lost');
    }
    const body = requestBody(init);
    return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce',
      enforced: false, coverage: 'evaluated', outcome: 'approval_required',
      recordingStatus: 'retained', reportReplayed: false,
      actionId: randomUUID(), approvalRequestId: randomUUID() }), { status: 200 });
  });
  let blocked: EnforceBlockedError | undefined;
  let effects = 0;
  try { await adapter.enforce(operation(), {}, () => { effects++; return {}; }); }
  catch (error) { if (error instanceof EnforceBlockedError) blocked = error; else throw error; }
  assert.ok(blocked);
  await assert.rejects(adapter.resumeApproval(blocked), EnforceBlockedError);
  await assert.rejects(adapter.resumeApproval(blocked), EnforceBlockedError);
  assert.equal(claims, 1);
  assert.equal(effects, 0);
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
