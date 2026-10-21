import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EnforceClient } from '../dist/index.js';

// Run against a reviewed Enforce deployment from the credential-owning application.
const privateKey = await readFile(process.env.AUTHRAIL_EXECUTOR_PRIVATE_KEY_FILE, 'utf8');
const client = new EnforceClient({
  sidecarUrl: process.env.AUTHRAIL_SIDECAR_URL,
  adapterToken: process.env.AUTHRAIL_ADAPTER_TOKEN,
  organisationId: process.env.AUTHRAIL_ORGANISATION_ID,
  deploymentId: process.env.AUTHRAIL_DEPLOYMENT_ID,
  executorPrivateKey: privateKey,
});
const providerLedger = new Map();
const checked = await client.enforce({
  operationVersionId: process.env.AUTHRAIL_OPERATION_VERSION_ID,
  actionKey: 'node-slice9-enforce', principalId: 'staff_123',
  principalSource: 'application_session', sessionId: 'node_tool_123',
  resourceId: null, resourceSource: 'not_applicable',
}, { amount: 10 }, async (input, recovery) => {
  assert.equal(input.amount, 10);
  assert.ok(recovery.providerIdempotencyKey.startsWith('ar-'));
  providerLedger.set(recovery.providerIdempotencyKey, { accepted: true });
  return { accepted: true };
});
assert.deepEqual(checked.result, { accepted: true });
assert.equal(checked.callDecision.recordingStatus, 'retained');
assert.equal(checked.resultDecision.recordingStatus, 'retained');
assert.equal(providerLedger.size, 1);
process.stdout.write('Node protected tool Enforce call and result retained\n');
