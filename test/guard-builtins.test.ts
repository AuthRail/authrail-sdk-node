import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { processGuard, registeredHandlers } from '../src/enforce/guard.js';
import { goJSON } from '../src/observe/protocol.js';

const id = 'authrail_redact_credentials_v1';
const version = 'cea4d8ac57cc39a33a9584742b56e412ff889026cb6b69b086bccbe4cc25d833';
const operationVersionId = '00000000-0000-4000-8000-000000000003';
const bundleId = '00000000-0000-4000-8000-000000000099';
const hash = (text: string) => createHash('sha256').update(goJSON(text)).digest('hex');

// Security risk: missed formats leak a credential; loose token boundaries destroy unrelated text.
test('built-in credential redaction has fixed formats and ASCII token boundaries', async () => {
  const gh = `ghp_${'a'.repeat(36)}`;
  const cases: Array<[string, boolean]> = [
    ...['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY']
      .map((kind): [string, boolean] => [`before -----BEGIN ${kind}----- after`, true]),
    ...['p', 'o', 'u', 's', 'r'].map((kind): [string, boolean] => [`gh${kind}_${'Z'.repeat(36)}`, true]),
    [`github_pat_${'a_'.repeat(41)}`, true],
    [`AKIA${'A1'.repeat(8)}`, true], [`ASIA${'09'.repeat(8)}`, true],
    [`(${gh})`, true], [`é${gh}é`, true],
    ['ordinary support reply', false], ['-----BEGIN PUBLIC KEY-----', false],
    [`ghp_${'a'.repeat(35)}`, false], [`ghp_${'a'.repeat(37)}`, false],
    [`prefix${gh}`, false], [`_${gh}`, false], [`${gh}_`, false],
    [`AKIA${'a'.repeat(16)}`, false], ['DEMO_SECRET', false],
  ];
  for (const phase of ['tool_call', 'tool_result'] as const) {
    for (const [text, detected] of cases) {
      const target = { root: phase === 'tool_call' ? 'arguments' : 'result', path: ['text'] };
      const input = { text, untouched: 'preserved' };
      const processed = await processGuard({ formatVersion: 1, operationVersionId, phase,
        bundleId, sequence: 1, coverage: 'evaluated', requirements: [{
          railVersionId: bundleId, ruleId: 'redact', kind: 'sanitize', handlerId: id,
          handlerVersion: version, target,
        }] }, operationVersionId, phase, input, registeredHandlers(undefined));
      const output = detected ? '[REDACTED]' : text;
      assert.deepEqual(processed.output, { text: output, untouched: 'preserved' }, text);
      assert.equal(input.text, text);
      assert.equal(processed.evidence[0]?.inputSha256, hash(text));
      assert.equal(processed.evidence[0]?.outputSha256, hash(output));
    }
  }
});

// Security risk: custom registration must never replace the trusted implementation.
test('custom handlers cannot shadow a built-in at any version or kind', () => {
  for (const candidateVersion of [version, 'a'.repeat(64)]) {
    for (const kind of ['sanitize', 'transform'] as const) {
      assert.throws(() => registeredHandlers([{ id, version: candidateVersion,
        kind, process: (text) => text }]));
    }
  }
});

// Local processing must remove reviewed data before disclosure without classifying
// ordinary identifiers, invalid numbers or unsupported forms as a passing detector.
test('email, payment-card and unconditional withholding process both reviewed phases', async () => {
  const handlers = [
    { id: 'authrail_redact_email_v1', version: '9773bce1f804773de4e773f4fedbc3f8a15785d26e70e49ad7b600eb631ea49d', replacement: '[REDACTED]',
      cases: [['Contact jane.doe+test@example.co.uk.', true], ['a@EXAMPLE.COM', true], ['a..b@example.com', false],
        ['a.@example.com', false], ['a@example.c', false], ['_name@example.com', false],
        ['name@example.com_', false], ['ordinary reply', false], [`${'a'.repeat(65)}@example.com`, false]] as Array<[string, boolean]> },
    { id: 'authrail_redact_payment_card_v1', version: '01c828b26465d66ad89cb6a350c82d9afa1d8673ee8e167acfc33bde27c1535b', replacement: '[REDACTED]',
      cases: [['Card 4111 1111 1111 1111.', true], ['378282246310005', true], ['4242-4242-4242-4242', true],
        ['4111111111111112', false], ['0000000000000000', false], ['41111111111111111111', false],
        ['４１１１１１１１１１１１１１１１', false], ['invoice 123456', false]] as Array<[string, boolean]> },
    { id: 'authrail_withhold_field_v1', version: '3ebd6aaea66cbd30459938a624b0f74d6bea612e28d6638273a67145b2fe5555', replacement: '[WITHHELD]',
      cases: [['protected instructions and arbitrary internal text', true], ['', true]] as Array<[string, boolean]> },
  ];
  for (const handler of handlers) {
    for (const phase of ['tool_call', 'tool_result'] as const) {
      for (const [text, found] of handler.cases) {
        const processed = await processGuard({ formatVersion: 1, operationVersionId, phase,
          bundleId, sequence: 1, coverage: 'evaluated', requirements: [{ railVersionId: bundleId,
            ruleId: 'protect', kind: 'sanitize', handlerId: handler.id, handlerVersion: handler.version,
            target: { root: phase === 'tool_call' ? 'arguments' : 'result', path: ['text'] },
          }] }, operationVersionId, phase, { text, kept: true }, registeredHandlers(undefined));
        const expected = found ? handler.replacement : text;
        assert.deepEqual(processed.output, { text: expected, kept: true });
        assert.equal(processed.evidence[0]?.inputSha256, hash(text));
        assert.equal(processed.evidence[0]?.outputSha256, hash(expected));
      }
    }
    assert.throws(() => registeredHandlers([{ id: handler.id, version: 'f'.repeat(64),
      kind: 'sanitize', process: (value) => value }]));
  }
});
