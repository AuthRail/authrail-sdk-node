import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { readContextual, type ContextualConnection } from '../src/observe/contextual.js';
import { encodeAttribution, fields, goJSON, type ObservedCall } from '../src/observe/protocol.js';

const id = '00000000-0000-4000-8000-000000000001';
const keys = generateKeyPairSync('ed25519');
const call: ObservedCall = { operationVersionId: id, requestId: id, actionKey: 'one-action',
  principalId: 'user', sessionId: 'session', principalSource: 'application_session', resourceSource: 'not_applicable',
  arguments: { diff: 'Synthetic permitted diff', privateField: 'must stay local' } };
const requirement = { railVersionId: id, assessment: { id: 'change', phase: 'tool_call',
  fields: [{ root: 'arguments', path: ['diff'] }], answer: { type: 'boolean' } } };
const plan = { formatVersion: 1, bundleId: id, operationVersionId: id, phase: 'tool_call',
  coverage: 'evaluated', requirements: [requirement], disclosureProcessing: false, disclosureRequirements: [] };
function connection(fetcher: typeof globalThis.fetch): ContextualConnection {
  return { sidecarUrl: 'http://127.0.0.1:7078', adapterToken: 'a'.repeat(32), organisationId: id,
    deploymentId: id, executorPrivateKey: keys.privateKey, fetch: fetcher };
}

// Selected fields, caller identity and phase must be signed before any material leaves the application.
test('hosted contextual request signs only reviewed material and exact caller context', async () => {
  let posts = 0;
  await readContextual(connection(async (url, options) => {
    if (options?.method === 'GET') return Response.json(plan);
    posts++;
    assert.equal(new URL(String(url)).pathname, '/contextual-readings');
    const body = JSON.parse(String(options?.body));
    const material = Buffer.from(body.material, 'base64url');
    assert.deepEqual(JSON.parse(material.toString()), [call.arguments.diff]);
    assert.equal(body.attributionSha256, createHash('sha256').update(encodeAttribution(call)).digest('hex'));
    const statement = fields([
      ['type', goJSON('authrail.contextual.request.v1')], ['organisationId', goJSON(id)], ['deploymentId', goJSON(id)],
      ['bundleId', goJSON(id)], ['railVersionId', goJSON(id)], ['assessmentId', goJSON('change')],
      ['operationVersionId', goJSON(id)], ['requestId', goJSON(id)], ['phase', goJSON('tool_call')],
      ['inputSha256', goJSON(body.inputSha256)], ['attributionSha256', goJSON(body.attributionSha256)],
      ['materialSha256', goJSON(createHash('sha256').update(material).digest('hex'))], ['keySha256', goJSON(body.keySha256)],
      ['issuedAt', goJSON(body.proof.issuedAt)], ['expiresAt', goJSON(body.proof.expiresAt)],
    ]);
    assert.equal(verify(null, Buffer.from(statement), keys.publicKey, Buffer.from(body.proof.signature, 'base64url')), true);
    return new Response(null, { status: 503 });
  }), call, 'tool_call', undefined);
  assert.equal(posts, 1);
});

test('disabled, missing and unprocessed contextual material is never sent', async () => {
  const disclosure = { handlerId: 'filter', handlerVersion: 'b'.repeat(64), kind: 'sanitize',
    target: { root: 'arguments', path: ['diff'] } };
  for (const selected of [
    { ...plan, requirements: [] },
    { ...plan, requirements: [{ ...requirement, assessment: { ...requirement.assessment, fields: [{ root: 'arguments', path: ['missing'] }] } }] },
    { ...plan, disclosureProcessing: true, disclosureRequirements: [disclosure] },
  ]) {
    let posts = 0;
    const findings = await readContextual(connection(async (_url, options) => {
      if (options?.method === 'GET') return Response.json(selected);
      posts++; throw new Error('unexpected disclosure');
    }), call, 'tool_call', undefined);
    assert.equal(posts, 0); assert.deepEqual(findings, []);
  }
});

test('a result-time interpretation of request fields requires their original processing evidence', async () => {
  const target = { root: 'arguments' as const, path: ['diff'] };
  const processing = { handlerId: 'filter', handlerVersion: 'b'.repeat(64), kind: 'sanitize' as const, target };
  const proof = { ...processing, phase: 'tool_call' as const, bundleId: id, inputSha256: 'a'.repeat(64),
    outputSha256: createHash('sha256').update(goJSON(call.arguments.diff)).digest('hex') };
  for (const item of [proof, { ...proof, bundleId: '00000000-0000-4000-8000-000000000002' }, null]) {
    let posts = 0;
    await readContextual(connection(async (_url, options) => {
      if (options?.method === 'GET') return Response.json({ ...plan, phase: 'tool_result',
        disclosureProcessing: true, disclosureRequirements: [processing] });
      posts++; return new Response(null, { status: 503 });
    }), { ...call, guardEvidence: item ? [item] : [] }, 'tool_result', {});
    assert.equal(posts, item === proof ? 1 : 0);
  }
});
