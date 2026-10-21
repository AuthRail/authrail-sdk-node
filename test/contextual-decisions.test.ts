import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContextFact, type ExtractionSource } from '../src/facts.js';
import { newOpenAIDecisionsExtractor, openAIDecisionsConfigSha256,
  type DecisionsQuestion } from '../src/contextual-decisions.js';

const question: DecisionsQuestion = { type: 'predicate', instructions: 'Does the message contain a payment card number?',
  minConfidence: 0.8 };
const source: ExtractionSource = {
  sourceVersionId: '00000000-0000-4000-8000-000000000030', sourceIdentity: 'support.messages',
  accountBoundary: 'tenant_123', lookup: 'message.read', resultPath: ['sensitive'],
  valueType: 'boolean', modelId: 'gpt-6-luna',
  modelConfigSha256: openAIDecisionsConfigSha256(question), promptVersion: 'prompt.v1',
  maxInputBytes: 4096, maxOutputBytes: 256, timeoutMs: 1000,
};

test('Decisions predicate supplies only a reviewed contextual fact', async () => {
  let requests = 0;
  const extractor = newOpenAIDecisionsExtractor({ source, question, apiKey: 'protected-key',
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, 'https://api.openai.com/v1/decisions');
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer protected-key');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.input, 'customer message');
      assert.deepEqual(body.questions, [{ type: 'predicate', name: 'fact', instructions: question.instructions }]);
      return new Response(JSON.stringify({ model: 'gpt-6-luna', answers: [
        { type: 'predicate', name: 'fact', probability: 0.94 }] }), { status: 200 });
    } });
  const resolution = await extractContextFact(source, 'msg_123', 'message:msg_123',
    new Date().toISOString(), new TextEncoder().encode('customer message'), extractor);
  assert.equal(requests, 1);
  assert.equal(resolution.status, 'ok');
  assert.deepEqual(resolution.value, { sensitive: true });
  assert.equal(resolution.extraction?.modelConfigSha256, source.modelConfigSha256);
});

test('refusal and threshold uncertainty cannot become a trusted fact', async () => {
  for (const answer of [
    { type: 'refusal', name: 'fact' },
    { type: 'predicate', name: 'fact', probability: 0.5 },
  ]) {
    const extractor = newOpenAIDecisionsExtractor({ source, question, apiKey: 'protected-key',
      fetch: async () => new Response(JSON.stringify({ model: 'gpt-6-luna', answers: [answer] })) });
    const resolution = await extractContextFact(source, 'msg_123', 'message:msg_123',
      new Date().toISOString(), new TextEncoder().encode('customer message'), extractor);
    assert.equal(resolution.status, 'uncertain');
    assert.equal(resolution.value, undefined);
  }
});

test('choice and score preserve reviewed output type and reject invalid responses', async () => {
  const cases: { question: DecisionsQuestion; valueType: ExtractionSource['valueType']; answer: object;
    expected: string | number }[] = [
    { question: { type: 'choice', instructions: 'Classify the ticket.', choices: ['billing', 'other'],
      minConfidence: 0.8 }, valueType: 'string',
    answer: { type: 'choice', name: 'fact', choice: 'billing', confidence: 0.91 }, expected: 'billing' },
    { question: { type: 'score', instructions: 'Rate urgency.', levels: ['low', 'medium', 'high'],
      minConfidence: 0.8 }, valueType: 'number',
    answer: { type: 'score', name: 'fact', score: 1.4, confidence: 0.91 }, expected: 1.4 },
  ];
  for (const entry of cases) {
    const reviewed = { ...source, valueType: entry.valueType,
      modelConfigSha256: openAIDecisionsConfigSha256(entry.question) };
    const extractor = newOpenAIDecisionsExtractor({ source: reviewed, question: entry.question,
      apiKey: 'protected-key', fetch: async () => new Response(JSON.stringify({
        model: 'gpt-6-luna', answers: [entry.answer] })) });
    const resolution = await extractContextFact(reviewed, 'msg_123', 'message:msg_123',
      new Date().toISOString(), new TextEncoder().encode('customer message'), extractor);
    assert.equal(resolution.status, 'ok');
    assert.equal(resolution.value?.sensitive, entry.expected);
  }
  assert.throws(() => newOpenAIDecisionsExtractor({ source: { ...source,
    modelConfigSha256: '0'.repeat(64) }, question, apiKey: 'protected-key' }));
});
