import { readFile } from 'node:fs/promises';
import { EnforceBlockedError, EnforceClient, extractContextFact,
  newOpenAIDecisionsExtractor, openAIDecisionsConfigSha256 } from '../dist/index.js';

const required = (name) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
};

// This source-shaped configuration must match the reviewed v5 bundle exactly.
const question = { type: 'predicate',
  instructions: 'Does the message request a transfer of more than 100 mock units?',
  minConfidence: 0.8 };
const source = {
  sourceVersionId: required('AUTHRAIL_CONTEXT_SOURCE_VERSION_ID'),
  sourceIdentity: 'verification.messages', accountBoundary: 'verification_account',
  lookup: 'message.read', timeoutMs: 10_000,
  resultPath: ['largeTransferRequest'], valueType: 'boolean',
  modelId: 'gpt-6-luna', modelConfigSha256: openAIDecisionsConfigSha256(question),
  promptVersion: 'verification.v1', maxInputBytes: 4096, maxOutputBytes: 256,
};
const testCase = required('AUTHRAIL_CONTEXT_CASE');
if (!['allow', 'deny', 'unavailable', 'uncertain'].includes(testCase)) {
  throw new Error('Unknown contextual verification case');
}
const amount = testCase === 'allow' ? 80 : 150;
const messageId = `message_${testCase}`;
const document = new TextEncoder().encode(
  `Please transfer ${amount} mock units to the demo account.`);
const observedAt = new Date().toISOString();
const extractor = testCase === 'unavailable'
  ? async () => { throw new Error('Synthetic source outage'); }
  : testCase === 'uncertain'
    ? async () => ({ value: true, uncertain: true, modelId: source.modelId,
      modelConfigSha256: source.modelConfigSha256, promptVersion: source.promptVersion })
    : newOpenAIDecisionsExtractor({ source, question, apiKey: required('OPENAI_API_KEY') });
const fact = await extractContextFact(source, messageId, `verification:${messageId}`,
  observedAt, document, extractor);
const client = new EnforceClient({
  sidecarUrl: required('AUTHRAIL_SIDECAR_URL'),
  adapterToken: required('AUTHRAIL_ADAPTER_TOKEN'),
  organisationId: required('AUTHRAIL_ORGANISATION_ID'),
  deploymentId: required('AUTHRAIL_DEPLOYMENT_ID'),
  executorPrivateKey: await readFile(required('AUTHRAIL_EXECUTOR_PRIVATE_KEY_FILE'), 'utf8'),
});
const summary = { case: testCase, factStatus: fact.status,
  factValue: fact.value?.largeTransferRequest ?? null,
  provenanceDigest: fact.extraction?.sourceSha256 ?? null,
  decision: null, recordingStatus: null, actionId: null,
  mockEffectCount: 0, outcome: 'not_started' };
const ledger = new Set();
try {
  const result = await client.enforce({
    operationVersionId: required('AUTHRAIL_CONTEXT_OPERATION_VERSION_ID'),
    actionKey: required('AUTHRAIL_ACTION_KEY'), principalId: 'fixture-customer',
    sessionId: `fixture-context-${required('AUTHRAIL_DEPLOYMENT_ID')}`,
    principalSource: 'application_session', resourceId: null,
    resourceSource: 'not_applicable', factResolutions: [fact],
  }, { amount, messageId }, async (_arguments, execution) => {
    ledger.add(execution.providerIdempotencyKey);
    summary.mockEffectCount = ledger.size;
    return { accepted: true };
  });
  summary.actionId = result.callDecision.actionId ?? null;
  summary.decision = result.callDecision.outcome;
  summary.recordingStatus = result.callDecision.recordingStatus ?? null;
  summary.outcome = 'completed';
} catch (error) {
  if (!(error instanceof EnforceBlockedError)) throw error;
  summary.actionId = error.decision?.actionId ?? null;
  summary.decision = error.decision?.outcome ?? null;
  summary.recordingStatus = error.decision?.recordingStatus ?? null;
  summary.outcome = error.phase === 'tool_call' ? 'call_blocked' : 'result_blocked';
}
process.stdout.write(`${JSON.stringify(summary)}\n`);
