import assert from 'node:assert/strict';
import { EnforceBlockedError, EnforceClient } from '../dist/index.js';

// Invoked by the Go SDK's isolated real-sidecar harness, with generated fixture
// credentials on stdin. This never connects to a customer deployment or provider.
let encoded = '';
for await (const chunk of process.stdin) encoded += chunk;
const config = JSON.parse(encoded);
const adapter = new EnforceClient({ ...config.client, guardHandlers: [] });
let effects = 0;
const execute = (input, execution) => {
  assert.equal(input.amount, 80);
  assert.equal(execution.providerIdempotencyKey, `ar-${config.actionId}`);
  effects++;
  input.amount = 999; // Local working data cannot rewrite the signed call.
  return { status: 'paid' };
};
const allowed = await adapter.enforce({ ...config.operation, actionKey: 'node-allowed' }, { amount: 80 }, execute);
assert.equal(allowed.result.status, 'paid');
assert.equal(allowed.callDecision.recordingStatus, 'retained');
assert.equal(allowed.resultDecision.outcome, 'allow');
await assert.rejects(adapter.enforce({ ...config.operation, actionKey: 'node-denied' }, { amount: 150 }, execute),
  (error) => error instanceof EnforceBlockedError && error.phase === 'tool_call');

let continuation;
try {
  await adapter.enforce({ ...config.operation, actionKey: 'node-approved' }, { amount: 70 }, execute);
} catch (error) {
  if (!(error instanceof EnforceBlockedError)) throw error;
  continuation = error.approvalContinuation;
}
assert.ok(continuation);
const stored = JSON.parse(JSON.stringify(continuation));
const restarted = new EnforceClient({ ...config.client, guardHandlers: [] });
const resumed = await restarted.recoverApprovalFrom(stored, (input) => {
  assert.equal(input.amount, 70); effects++; return { status: 'paid' };
});
assert.equal(resumed.resultDecision.outcome, 'approval_required');
await assert.rejects(restarted.recoverApprovalFrom(stored, () => { effects++; return {}; }),
  (error) => error instanceof EnforceBlockedError && error.phase === 'tool_call');
assert.equal(effects, 2);
console.log('Node: real sidecar allowed call/result, denial with no effect, persisted permit recovery, and duplicate-start blocking passed.');
