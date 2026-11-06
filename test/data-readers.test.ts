import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { test } from 'node:test';
import { EnforceBlockedError, EnforceClient } from '../src/index.js';
import type { ApprovalContinuation, DataSourceBinding, FactResolution, GuardEvidence,
  JSONObject, ObserveOperation } from '../src/index.js';
import { encodeInput } from '../src/observe/protocol.js';
import { registeredDataSources, resolveData } from '../src/observe/data.js';
import type { ObservedCall } from '../src/observe/protocol.js';

const organisationId = '00000000-0000-4000-8000-000000000001';
const deploymentId = '00000000-0000-4000-8000-000000000002';
const operationVersionId = '00000000-0000-4000-8000-000000000003';
const sourceVersionId = '00000000-0000-4000-8000-000000000004';
const bundleId = '00000000-0000-4000-8000-000000000005';
const actionId = '00000000-0000-4000-8000-000000000006';
const approvalRequestId = '00000000-0000-4000-8000-000000000007';
const permitId = '00000000-0000-4000-8000-000000000008';
const adapterToken = 'abcdefghijklmnopqrstuvwxyz012345';
const keys = generateKeyPairSync('ed25519');
const operation: ObserveOperation = { operationVersionId, actionKey: 'invoice-payment-1',
  principalId: 'employee-1', sessionId: 'workflow-1', resourceId: 'invoice-1',
  principalSource: 'application_session', resourceSource: 'application_lookup' };
const contract = { formatVersion: 4, kind: 'sdk', sourceIdentity: 'billing-service',
  accountBoundary: 'account-1', lookup: 'invoice.read',
  queryField: { root: 'arguments', path: ['invoiceId'] }, factKey: 'balance', resultPath: ['balance'],
  valueType: 'number', maxAgeSeconds: 60, timeoutMs: 1000, failure: 'unavailable' };
type Proof = { issuedAt: number; expiresAt: number; signature: string };
type EvaluationBody = { requestId: string; operationVersionId: string; phase: 'tool_call' | 'tool_result';
  arguments: JSONObject; result?: JSONObject; factResolutions?: FactResolution[]; guardEvidence?: GuardEvidence[];
  attribution: Pick<ObserveOperation, 'principalId' | 'sessionId' | 'resourceId' | 'principalSource' | 'resourceSource'>;
  identityProof: Proof };
type ReceiptBody = { actionId: string; attemptId: string; permitId: string | null; event: string;
  inputSha256: string; providerIdempotencyKey: string; providerReference: string | null;
  keySha256: string; proof: Proof };
type ClaimBody = { approvalRequestId: string; actionId: string; inputSha256: string; keySha256: string; proof: Proof };

function signature(statement: object, proof: Proof) {
  assert.equal(verify(null, Buffer.from(JSON.stringify(statement)), keys.publicKey,
    Buffer.from(proof.signature, 'base64url')), true, 'exact statement signature');
}

function harness(options: { wrongResource?: boolean; wrongAccount?: boolean; missingBinding?: boolean;
  approval?: boolean; drift?: boolean; stripe?: boolean } = {}) {
  let readerCalls = 0;
  let initialDigest = '';
  const evaluations: EvaluationBody[] = [];
  const events: string[] = [];
  const failures: unknown[] = [];
  const binding: DataSourceBinding = options.stripe ? {
    sourceVersionId, kind: 'stripe', providerAccountId: 'acct_12345678', secretKey: 'private-test-key',
    resolveResource: (context) => { assert.equal(context.resourceId, 'invoice-1'); return 'in_1234'; },
    fetch: async (input) => {
      readerCalls++;
      const path = new URL(String(input)).pathname;
      assert.ok(path === '/v1/account' || path === '/v1/invoices/in_1234');
      return new Response(JSON.stringify(path === '/v1/account'
        ? { object: 'account', id: 'acct_12345678' }
        : { object: 'invoice', id: 'in_1234', status: 'open' }));
    },
  } : {
    sourceVersionId, kind: 'sdk', sourceIdentity: 'billing-service',
    accountBoundary: options.wrongAccount ? 'another-account' : 'account-1', lookup: 'invoice.read',
    resolveResource: (context) => {
      assert.deepEqual(context, { principalId: 'employee-1', sessionId: 'workflow-1',
        resourceId: 'invoice-1', operationVersionId });
      return options.wrongResource ? 'other-invoice' : 'invoice-1';
    },
    read: async (lookupKey) => { readerCalls++; return { sourceIdentity: 'billing-service',
      accountBoundary: 'account-1', lookup: 'invoice.read', lookupKey,
      observedAt: new Date().toISOString(), value: { balance: readerCalls === 1 ? 80 : 60 } }; },
  };
  const sourceContract = options.stripe ? { formatVersion: 1, provider: 'stripe', lookup: 'invoice.retrieve',
    providerAccountId: 'acct_12345678', queryField: contract.queryField, factKey: 'status', resultField: 'status',
    maxAgeSeconds: 60, timeoutMs: 1000, failure: 'unavailable' } : contract;
  const transport: typeof fetch = async (input, init) => {
    try {
      const url = new URL(String(input));
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${adapterToken}`);
      if (url.pathname === '/contextual-requirements') return new Response(null, { status: 404 });
      if (url.pathname === '/guard-requirements' || url.pathname === '/data-requirements') {
        assert.equal(init?.method, 'GET');
        assert.equal(url.searchParams.get('operationVersionId'), operationVersionId);
        return new Response(JSON.stringify({ formatVersion: 1, operationVersionId,
          phase: url.searchParams.get('phase'), bundleId, sequence: 1, coverage: 'evaluated',
          requirements: url.pathname === '/data-requirements' ? [{ sourceVersionId, contract: sourceContract }] : [] }));
      }
      if (url.pathname === '/evaluate') {
        const body = JSON.parse(String(init?.body)) as EvaluationBody;
        const call: ObservedCall = { ...operation, ...body.attribution,
          actionKey: new Headers(init?.headers).get('Idempotency-Key')!, requestId: body.requestId,
          arguments: body.arguments, factResolutions: body.factResolutions, guardEvidence: body.guardEvidence };
        const inputSha256 = createHash('sha256').update(encodeInput(call, body.phase, body.result)).digest('hex');
        signature({ type: 'authrail.observe.executor.v1', organisationId, deploymentId,
          requestId: body.requestId, actionKey: call.actionKey, operationVersionId, phase: body.phase,
          inputSha256, attribution: body.attribution,
          issuedAt: body.identityProof.issuedAt, expiresAt: body.identityProof.expiresAt }, body.identityProof);
        assert.equal(body.factResolutions?.length, 1);
        assert.equal(body.factResolutions[0]!.sourceVersionId, sourceVersionId);
        evaluations.push(body);
        if (body.phase === 'tool_call') initialDigest = inputSha256;
        const status = body.factResolutions[0]!.status;
        return new Response(JSON.stringify({ requestId: body.requestId, mode: 'enforce', enforced: false,
          coverage: 'evaluated', outcome: status !== 'ok' ? 'additional_context_required'
            : options.approval && body.phase === 'tool_call' ? 'approval_required' : 'allow',
          recordingStatus: 'retained', reportReplayed: false, actionId,
          ...(options.approval ? { approvalRequestId } : {}),
          bundleId: options.drift ? randomUUID() : bundleId, sequence: 1 }));
      }
      if (url.pathname === '/approval-permits/claim') {
        const body = JSON.parse(String(init?.body)) as ClaimBody;
        assert.equal(body.inputSha256, initialDigest, 'claim preserves original checked facts');
        signature({ type: 'authrail.approval.claim.v1', organisationId, deploymentId,
          approvalRequestId: body.approvalRequestId, actionId: body.actionId, inputSha256: body.inputSha256,
          keySha256: body.keySha256, issuedAt: body.proof.issuedAt, expiresAt: body.proof.expiresAt }, body.proof);
        events.push('claim');
        return new Response(JSON.stringify({ permitId, actionId, expiresAt: new Date(Date.now() + 60000).toISOString() }), { status: 201 });
      }
      assert.equal(url.pathname, '/execution-receipts');
      const body = JSON.parse(String(init?.body)) as ReceiptBody;
      assert.equal(body.inputSha256, initialDigest, 'receipt preserves original checked facts');
      signature({ type: 'authrail.execution.receipt.v1', organisationId, deploymentId,
        actionId: body.actionId, attemptId: body.attemptId, permitId: body.permitId, event: body.event,
        inputSha256: body.inputSha256, providerIdempotencyKey: body.providerIdempotencyKey,
        providerReference: body.providerReference, keySha256: body.keySha256,
        issuedAt: body.proof.issuedAt, expiresAt: body.proof.expiresAt }, body.proof);
      events.push(body.event);
      return new Response(JSON.stringify({ receiptId: randomUUID(),
        state: body.event === 'started' ? 'executing' : 'succeeded', replayed: false }), { status: 201 });
    } catch (error) { failures.push(error); throw error; }
  };
  const create = () => new EnforceClient({ sidecarUrl: 'http://127.0.0.1:7078', adapterToken,
    organisationId, deploymentId, executorPrivateKey: keys.privateKey, fetch: transport,
    dataSources: options.missingBinding ? [] : [binding] });
  return { create, evaluations, events, failures, readCount: () => readerCalls,
    args: { invoiceId: options.stripe ? 'in_1234' : 'invoice-1', amount: 50 } };
}

// Signed decisions, receipts and saved approvals must bind the exact automatically read facts.
test('automatic application and Stripe reads preserve signed fact and execution digests', async () => {
  for (const stripe of [false, true]) {
    const h = harness({ stripe });
    const args = { ...h.args };
    let effects = 0;
    await h.create().enforce(operation, args, (checked) => { effects++; assert.deepEqual(checked, args); return { done: true }; });
    assert.equal(effects, 1);
    assert.deepEqual(args, h.args, 'caller arguments unchanged');
    assert.deepEqual(h.events, ['started', 'succeeded']);
    assert.deepEqual(h.failures, []);
    assert.equal(h.evaluations.length, 2);
    assert.ok(h.evaluations.every((body) => body.factResolutions?.[0]?.status === 'ok'));
  }
});

test('wrong resources, wrong accounts and missing bindings do not run a provider read or protected effect', async () => {
  for (const options of [{ wrongResource: true }, { wrongAccount: true }, { missingBinding: true }]) {
    const h = harness(options);
    let effects = 0;
    await assert.rejects(h.create().enforce(operation, h.args, () => { effects++; return {}; }), EnforceBlockedError);
    assert.equal(effects, 0);
    assert.equal(h.readCount(), 0);
    assert.equal(h.evaluations[0]!.factResolutions?.[0]?.status, options.missingBinding ? 'unavailable' : 'untrusted');
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.failures, []);
  }
});

test('a changed Data bundle blocks execution even after an allowed decision', async () => {
  const h = harness({ drift: true });
  let effects = 0;
  await assert.rejects(h.create().enforce(operation, h.args, () => { effects++; return {}; }), EnforceBlockedError);
  assert.equal(effects, 0);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.failures, []);
});

test('a saved approval resumes the original generated facts rather than rereading its checked call', async () => {
  const h = harness({ approval: true });
  let continuation: ApprovalContinuation | undefined;
  try { await h.create().enforce(operation, h.args, () => { throw new Error('must not execute before approval'); }); }
  catch (error) {
    assert.ok(error instanceof EnforceBlockedError);
    continuation = error.approvalContinuation;
  }
  assert.ok(continuation);
  const saved = JSON.parse(JSON.stringify(continuation)) as ApprovalContinuation;
  assert.deepEqual(saved.call.factResolutions?.[0]?.value, { balance: 80 });
  let effects = 0;
  await h.create().resumeApprovalFrom(saved, () => { effects++; return { done: true }; });
  assert.equal(effects, 1);
  assert.equal(h.readCount(), 2, 'only result-phase facts are refreshed after approval');
  assert.deepEqual(h.evaluations[0]!.factResolutions?.[0]?.value, { balance: 80 });
  assert.deepEqual(h.evaluations[1]!.factResolutions?.[0]?.value, { balance: 60 });
  assert.deepEqual(h.events, ['claim', 'started', 'succeeded']);
  assert.deepEqual(h.failures, []);
});


// A completed reader must not change its checked value while another source is pending.
test('completed Data reads snapshot application-owned values before waiting for other sources', async () => {
  const secondSource = '00000000-0000-4000-8000-000000000009';
  const shared = { balance: 80 };
  const bindings = registeredDataSources([sourceVersionId, secondSource].map((id): DataSourceBinding => ({
    sourceVersionId: id, kind: 'sdk', sourceIdentity: 'billing-service', accountBoundary: 'account-1',
    lookup: 'invoice.read', resolveResource: () => 'invoice-1',
    read: async (lookupKey) => {
      if (id === secondSource) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        shared.balance = 999;
      }
      return { sourceIdentity: 'billing-service', accountBoundary: 'account-1', lookup: 'invoice.read',
        lookupKey, observedAt: new Date().toISOString(), value: id === secondSource ? { balance: 60 } : shared };
    },
  })));
  const transport: typeof fetch = async () => new Response(JSON.stringify({ formatVersion: 1,
    operationVersionId, phase: 'tool_call', bundleId, sequence: 1, coverage: 'evaluated',
    requirements: [sourceVersionId, secondSource].map((id) => ({ sourceVersionId: id, contract })) }));
  const resolved = await resolveData({ sidecarUrl: 'http://127.0.0.1:7078', adapterToken, fetch: transport },
    bindings, { ...operation, requestId: randomUUID(), arguments: { invoiceId: 'invoice-1' } }, 'tool_call');
  assert.equal(shared.balance, 999);
  assert.equal(resolved.resolutions?.[0]?.value?.balance, 80, 'completed fact retains its original validated value');
});
