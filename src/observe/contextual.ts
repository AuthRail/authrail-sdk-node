import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { boundedJSON, encodeAttribution, encodeInput, fields, goJSON, jsonObject, type ObservedCall, type Phase } from './protocol.js';

export type ContextualFinding = { payload: string; keyId: string; algorithm: 'ECDSA_SHA_256'; signature: string };
export type ContextualConnection = { sidecarUrl: string; adapterToken: string;
  organisationId: string; deploymentId: string; executorPrivateKey: KeyObject; fetch: typeof globalThis.fetch };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const name = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** Obtains AuthRail findings for signed Rail requirements; model operation stays inside AuthRail. */
export async function readContextual(connection: ContextualConnection, call: ObservedCall,
  phase: Phase, result: unknown): Promise<ContextualFinding[]> {
  const planURL = new URL('/contextual-requirements', connection.sidecarUrl);
  planURL.searchParams.set('operationVersionId', call.operationVersionId);
  planURL.searchParams.set('phase', phase);
  const headers = { Authorization: `Bearer ${connection.adapterToken}`,
    ...(call.traceparent ? { traceparent: call.traceparent } : {}) };
  const response = await connection.fetch(planURL, { method: 'GET', redirect: 'manual', headers,
    signal: AbortSignal.timeout(4000) });
  // An older runtime has no contextual endpoint; its evaluator cannot satisfy contextual conditions.
  if (response.status === 404) return [];
  if (response.status !== 200) throw new Error('Contextual requirements are unavailable');
  const plan = await boundedJSON(response);
  if (!jsonObject(plan) || plan.formatVersion !== 1 || plan.operationVersionId !== call.operationVersionId ||
    plan.phase !== phase || !Array.isArray(plan.requirements) || plan.requirements.length > 8) {
    throw new Error('Contextual requirements are invalid');
  }
  if (['uncovered', 'unavailable'].includes(String(plan.coverage)) && plan.requirements.length === 0) return [];
  if (plan.coverage !== 'evaluated' || typeof plan.bundleId !== 'string' || !uuid.test(plan.bundleId)) {
    throw new Error('Contextual requirements are invalid');
  }
  const findings: ContextualFinding[] = [];
  if (plan.disclosureProcessing === true && !processedDisclosure(plan, call, phase, result)) return findings;
  const inputSha256 = createHash('sha256').update(encodeInput(call, phase, result)).digest('hex');
  const attributionSha256 = createHash('sha256').update(encodeAttribution(call)).digest('hex');
  const publicKey = createPublicKey(connection.executorPrivateKey).export({ format: 'jwk' });
  if (!publicKey.x) throw new Error('Application signing identity is unavailable');
  const keySha256 = createHash('sha256').update(Buffer.from(publicKey.x, 'base64url')).digest('hex');
  const seen = new Set<string>();
  for (const requirement of plan.requirements) {
    if (!jsonObject(requirement) || typeof requirement.railVersionId !== 'string' ||
      !uuid.test(requirement.railVersionId) || !jsonObject(requirement.assessment)) {
      throw new Error('Contextual requirement is invalid');
    }
    const assessment = requirement.assessment;
    if (typeof assessment.id !== 'string' || !name.test(assessment.id) ||
      !['tool_call', 'tool_result'].includes(String(assessment.phase)) ||
      !Array.isArray(assessment.fields) || assessment.fields.length < 1 || assessment.fields.length > 4) {
      throw new Error('Contextual assessment is invalid');
    }
    const identity = `${requirement.railVersionId}:${assessment.id}`;
    if (seen.has(identity)) throw new Error('Contextual assessment is duplicated');
    seen.add(identity);
    const selected: string[] = [];
    for (const field of assessment.fields) {
      if (!jsonObject(field) || !['arguments', 'result'].includes(String(field.root)) ||
        phase === 'tool_call' && field.root === 'result' || !Array.isArray(field.path) ||
        field.path.length < 1 || field.path.length > 8 ||
        field.path.some((part) => typeof part !== 'string' || !name.test(part) || forbidden.has(part))) {
        throw new Error('Contextual material selection is invalid');
      }
      let value: unknown = field.root === 'arguments' ? call.arguments : result;
      for (const part of field.path) {
        value = typeof part === 'string' && jsonObject(value) && Object.hasOwn(value, part) ? value[part] : undefined;
      }
      if (typeof value !== 'string' || !value.trim()) break;
      selected.push(value);
    }
    if (selected.length !== assessment.fields.length) continue;
    const materialBytes = Buffer.from(goJSON(selected));
    if (materialBytes.byteLength > 16_384) continue;
    const materialSha256 = createHash('sha256').update(materialBytes).digest('hex');
    const issuedAt = Math.floor(Date.now() / 1000), expiresAt = issuedAt + 30;
    const statement = fields([
      ['type', goJSON('authrail.contextual.request.v1')], ['organisationId', goJSON(connection.organisationId)],
      ['deploymentId', goJSON(connection.deploymentId)], ['bundleId', goJSON(plan.bundleId)],
      ['railVersionId', goJSON(requirement.railVersionId)], ['assessmentId', goJSON(assessment.id)],
      ['operationVersionId', goJSON(call.operationVersionId)], ['requestId', goJSON(call.requestId)],
      ['phase', goJSON(phase)], ['inputSha256', goJSON(inputSha256)],
      ['attributionSha256', goJSON(attributionSha256)],
      ['materialSha256', goJSON(materialSha256)], ['keySha256', goJSON(keySha256)],
      ['issuedAt', goJSON(issuedAt)], ['expiresAt', goJSON(expiresAt)],
    ]);
    const body = { formatVersion: 1, bundleId: plan.bundleId, railVersionId: requirement.railVersionId,
      assessmentId: assessment.id, operationVersionId: call.operationVersionId, requestId: call.requestId,
      phase, inputSha256, attributionSha256, material: materialBytes.toString('base64url'), keySha256,
      proof: { issuedAt, expiresAt, signature: sign(null, Buffer.from(statement), connection.executorPrivateKey).toString('base64url') } };
    try {
      const reading = await connection.fetch(new URL('/contextual-readings', connection.sidecarUrl), {
        method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
      });
      if (reading.status !== 200) continue;
      const finding = await boundedJSON(reading);
      if (!jsonObject(finding) || Object.keys(finding).length !== 4 ||
        typeof finding.payload !== 'string' || finding.payload.length > 4096 ||
        typeof finding.keyId !== 'string' || finding.algorithm !== 'ECDSA_SHA_256' ||
        typeof finding.signature !== 'string') continue;
      findings.push(finding as unknown as ContextualFinding);
    } catch { /* The evaluator receives a missing finding, never an invented answer. */ }
  }
  return findings;
}

/** Processing evidence must cover the selected bundle and actual processed fields before disclosure. */
function processedDisclosure(plan: Record<string, unknown>, call: ObservedCall, phase: Phase, result: unknown): boolean {
  if (!Array.isArray(plan.disclosureRequirements) || !plan.disclosureRequirements.length ||
    plan.disclosureRequirements.length > 128) return false;
  return plan.disclosureRequirements.every((requirement: unknown) => {
    if (!jsonObject(requirement) || !jsonObject(requirement.target) ||
      !['arguments', 'result'].includes(String(requirement.target.root)) ||
      !Array.isArray(requirement.target.path) || !requirement.target.path.length || requirement.target.path.length > 8 ||
      requirement.target.path.some((part) => typeof part !== 'string' || !name.test(part) || forbidden.has(part))) return false;
    const target = requirement.target;
    const processingPhase = target.root === 'arguments' ? 'tool_call' : 'tool_result';
    if (phase === 'tool_call' && processingPhase === 'tool_result') return false;
    let value: unknown = target.root === 'arguments' ? call.arguments : result;
    for (const part of target.path as string[]) value = jsonObject(value) && Object.hasOwn(value, part) ? value[part] : undefined;
    if (typeof value !== 'string') return false;
    const output = createHash('sha256').update(goJSON(value)).digest('hex');
    const proofs = call.guardEvidence?.filter((proof) => proof.bundleId === plan.bundleId && proof.phase === processingPhase &&
      proof.handlerId === requirement.handlerId && proof.handlerVersion === requirement.handlerVersion &&
      proof.kind === requirement.kind && proof.target.root === target.root &&
      JSON.stringify(proof.target.path) === JSON.stringify(target.path)) ?? [];
    return proofs.length === 1 && proofs[0]?.outputSha256 === output;
  });
}
