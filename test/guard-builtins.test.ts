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
