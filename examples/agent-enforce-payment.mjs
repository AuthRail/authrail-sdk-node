import { readFile } from 'node:fs/promises';
import { EnforceBlockedError, EnforceClient, EnforceOutcomeUnknownError } from '../dist/index.js';

// The app owns both credentials and the protected tool. The model sees only its schema.
const required = (name) => {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing ${name}`);
  return value;
};

const decisionSummary = (decision) => decision && ({
  outcome: decision.outcome,
  coverage: decision.coverage,
  recordingStatus: decision.recordingStatus ?? null,
  approvalRequestId: decision.approvalRequestId ?? null,
});

const summary = {
  attemptedTool: false,
  actionId: null,
  callDecision: null,
  mockEffectCount: 0,
  providerKeyReference: null,
  resultDecision: null,
  outcome: 'not_started',
};

async function openAIResponse(apiKey, body) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenAI Responses returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== 'completed' || !Array.isArray(result.output)) {
    throw new Error('OpenAI Responses did not complete');
  }
  return result;
}

try {
  const apiKey = required('OPENAI_API_KEY');
  const model = required('OPENAI_MODEL');
  const prompt = process.env.AUTHRAIL_AGENT_PROMPT?.trim() || 'Please make a mock payment of 80 units.';
  if (prompt.length > 1000) throw new Error('AUTHRAIL_AGENT_PROMPT exceeds 1000 characters');
  const actionKey = required('AUTHRAIL_ACTION_KEY');
  const principalId = required('AUTHRAIL_PRINCIPAL_ID');
  const sessionId = required('AUTHRAIL_SESSION_ID');
  const operationVersionId = required('AUTHRAIL_OPERATION_VERSION_ID');
  const privateKey = await readFile(required('AUTHRAIL_EXECUTOR_PRIVATE_KEY_FILE'), 'utf8');
  const client = new EnforceClient({
    sidecarUrl: required('AUTHRAIL_SIDECAR_URL'),
    adapterToken: required('AUTHRAIL_ADAPTER_TOKEN'),
    organisationId: required('AUTHRAIL_ORGANISATION_ID'),
    deploymentId: required('AUTHRAIL_DEPLOYMENT_ID'),
    executorPrivateKey: privateKey,
  });

  const tool = {
    type: 'function', name: 'make_mock_payment',
    description: 'Attempt one mock payment in integer units. The application checks authorization before recording it.',
    parameters: {
      type: 'object', properties: { amount: { type: 'integer', minimum: 1, maximum: 1000 } },
      required: ['amount'], additionalProperties: false,
    },
    strict: true,
  };
  const instructions = 'Use make_mock_payment only when the user asks for a payment. This is a mock payment; do not claim real funds moved.';
  const input = [{ role: 'user', content: prompt }];
  const first = await openAIResponse(apiKey, {
    model, instructions, input, tools: [tool], parallel_tool_calls: false,
    max_output_tokens: 1024, store: false, include: ['reasoning.encrypted_content'],
  });
  const calls = first.output.filter((item) => item.type === 'function_call');
  if (calls.length === 0) {
    summary.outcome = 'model_did_not_call_tool';
  } else if (calls.length !== 1 || calls[0].name !== tool.name ||
    typeof calls[0].call_id !== 'string') {
    summary.outcome = 'unexpected_tool_call';
  } else {
    const call = calls[0];
    summary.attemptedTool = true;
    let argumentsValue;
    try { argumentsValue = JSON.parse(call.arguments); } catch { /* The model input is untrusted. */ }
    if (!argumentsValue || Array.isArray(argumentsValue) ||
      Object.keys(argumentsValue).length !== 1 ||
      !Number.isInteger(argumentsValue.amount) ||
      argumentsValue.amount < 1 || argumentsValue.amount > 1000) {
      summary.outcome = 'invalid_tool_arguments';
    } else {
      const ledger = new Map();
      try {
        const checked = await client.enforce({
          operationVersionId, actionKey, principalId, sessionId,
          principalSource: 'application_session',
          resourceId: null, resourceSource: 'not_applicable',
          reviewSummary: {
            title: 'Make mock payment',
            fields: [{ label: 'Amount', value: `${argumentsValue.amount} mock units` }],
          },
        }, argumentsValue, async (checkedArguments, execution) => {
          // A real provider adapter must persist or query this key across process restarts.
          const existing = ledger.get(execution.providerIdempotencyKey);
          if (existing) return existing;
          const result = { accepted: true, amount: checkedArguments.amount };
          ledger.set(execution.providerIdempotencyKey, result);
          summary.mockEffectCount = ledger.size;
          summary.providerKeyReference = execution.providerIdempotencyKey;
          return result;
        });
        summary.actionId = checked.callDecision.actionId ?? null;
        summary.callDecision = decisionSummary(checked.callDecision);
        summary.resultDecision = decisionSummary(checked.resultDecision);
        summary.outcome = 'completed';

        // With store:false, replay the model items and the matching function output.
        await openAIResponse(apiKey, {
          model, instructions,
          input: [...input, ...first.output, {
            type: 'function_call_output', call_id: call.call_id,
            output: JSON.stringify(checked.result),
          }],
          tools: [], max_output_tokens: 1024, store: false,
        });
      } catch (error) {
        if (error instanceof EnforceBlockedError) {
          summary.actionId = error.decision?.actionId ?? null;
          summary.callDecision = error.phase === 'tool_call' ? decisionSummary(error.decision) : null;
          summary.resultDecision = error.phase === 'tool_result' ? decisionSummary(error.decision) : null;
          summary.outcome = error.phase === 'tool_result' ? 'result_blocked_effect_may_have_occurred' : 'call_blocked';
        } else if (error instanceof EnforceOutcomeUnknownError) {
          summary.actionId = error.recovery?.actionId ?? null;
          summary.providerKeyReference = error.recovery?.providerIdempotencyKey ?? summary.providerKeyReference;
          summary.outcome = 'effect_outcome_unknown';
        } else {
          summary.outcome = summary.mockEffectCount > 0 ? 'effect_reported_model_continuation_failed' : 'error';
        }
      }
    }
  }
} catch {
  summary.outcome = 'configuration_or_model_error';
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
if (['model_did_not_call_tool', 'unexpected_tool_call', 'invalid_tool_arguments',
  'configuration_or_model_error', 'error'].includes(summary.outcome)) process.exitCode = 1;
