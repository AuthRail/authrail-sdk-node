import { createHash, createPrivateKey, createPublicKey, KeyObject, randomUUID, sign } from 'node:crypto';
import type { ObservedCall, Phase } from './protocol.js';
import {
  boundedJSON,
  encodeAttribution,
  encodeInput,
  fields,
  freezeContext,
  goJSON,
  jsonObject,
} from './protocol.js';
import type {
  JSONObject,
  Observation,
  ObserveClientConfig,
  ObserveDecision,
  ObserveOperation,
  ObservedExecutionOutcome,
  ObservedExecutionRecording,
} from './types.js';

type Checked = { decision: ObserveDecision | null; error: unknown };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reference = /^[A-Za-z0-9._:-]{1,128}$/;
const outcomes = new Set([
  'allow',
  'deny',
  'approval_required',
  'additional_context_required',
  'indeterminate',
]);
const coverage = new Set(['evaluated', 'uncovered', 'unavailable']);
const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Sends advisory call and result checks to one loopback sidecar deployment. */
export class ObserveClient {
  #endpoint: URL;
  #token: string;
  #organisationId: string;
  #deploymentId: string;
  #privateKey: KeyObject;
  #fetch: typeof globalThis.fetch;

  constructor(config: ObserveClientConfig) {
    const url = new URL(config.sidecarUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !reference.test(config.adapterToken) ||
      config.adapterToken.length < 32 ||
      !uuid.test(config.organisationId) ||
      !uuid.test(config.deploymentId)
    ) {
      throw new Error('Observe client configuration is invalid');
    }
    const privateKey =
      config.executorPrivateKey instanceof KeyObject
        ? config.executorPrivateKey
        : createPrivateKey(config.executorPrivateKey);
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Executor key must be a private Ed25519 key');
    }
    this.#endpoint = new URL('/evaluate', url);
    this.#token = config.adapterToken;
    this.#organisationId = config.organisationId;
    this.#deploymentId = config.deploymentId;
    this.#privateKey = privateKey;
    this.#fetch = config.fetch ?? fetch;
  }

  /** Runs the protected function independently of the checks; read observation for coverage gaps. */
  observe<Result>(
    operation: ObserveOperation,
    argumentsValue: JSONObject,
    execute: () => Result | Promise<Result>,
  ): { result: Promise<Result>; observation: Promise<Observation>; call: ObservedCall | undefined } {
    if (typeof execute !== 'function') throw new Error('Protected tool function is required');
    let call: ObservedCall | undefined;
    let callCheck: Promise<Checked>;
    try {
      call = this.prepare(operation, argumentsValue);
      callCheck = this.evaluate(call, 'tool_call', 'observe').then(
        (decision) => ({ decision, error: null }),
        (error) => ({ decision: null, error }),
      );
    } catch (error) {
      callCheck = Promise.resolve({ decision: null, error });
    }
    const result = Promise.resolve().then(() => execute());
    const observation: Promise<Observation> = result.then(
      async (value) => {
        const checkedCall = await callCheck;
        let bounded = false;
        try {
          bounded = jsonObject(value) && Buffer.byteLength(goJSON(value)) <= 64 * 1024;
        } catch {
          bounded = false;
        }
        if (!call) {
          return {
            callDecision: null,
            callError: checkedCall.error,
            resultDecision: null,
            resultError: checkedCall.error,
          };
        }
        if (!bounded) {
          return {
            callDecision: checkedCall.decision,
            callError: checkedCall.error,
            resultDecision: null,
            resultError: new Error('Tool result is not a bounded JSON object'),
          };
        }
        try {
          const resultDecision = await this.evaluate(call, 'tool_result', 'observe', value);
          return {
            callDecision: checkedCall.decision,
            callError: checkedCall.error,
            resultDecision,
            resultError: null,
          };
        } catch (error) {
          return {
            callDecision: checkedCall.decision,
            callError: checkedCall.error,
            resultDecision: null,
            resultError: error,
          };
        }
      },
      async () => {
        const checkedCall = await callCheck;
        return {
          callDecision: checkedCall.decision,
          callError: checkedCall.error,
          resultDecision: null,
          resultError: new Error('Tool result unavailable after tool error'),
        };
      },
    );
    return { result, observation, call };
  }

  /** Prepare one immutable action before a protected call; reused for the result phase. */
  prepare(operation: ObserveOperation, argumentsValue: JSONObject): ObservedCall {
    const snapshot = freezeContext({
      operationVersionId: operation.operationVersionId,
      actionKey: operation.actionKey,
      principalId: operation.principalId,
      sessionId: operation.sessionId,
      principalSource: operation.principalSource,
      resourceSource: operation.resourceSource,
      ...(operation.resourceId !== undefined ? { resourceId: operation.resourceId } : {}),
      ...(operation.factResolutions !== undefined
        ? { factResolutions: operation.factResolutions } : {}),
      ...(operation.trajectory !== undefined ? { trajectory: operation.trajectory } : {}),
      ...(operation.reviewSummary !== undefined ? { reviewSummary: operation.reviewSummary } : {}),
      ...(operation.traceparent !== undefined ? { traceparent: operation.traceparent } : {}),
      arguments: argumentsValue,
    });
    if (!uuid.test(snapshot.operationVersionId) || !reference.test(snapshot.actionKey) ||
      !reference.test(snapshot.principalId) || !reference.test(snapshot.sessionId) ||
      (snapshot.resourceId !== undefined && snapshot.resourceId !== null &&
        !reference.test(snapshot.resourceId)) || !jsonObject(snapshot.arguments) ||
      Buffer.byteLength(goJSON(snapshot.arguments)) > 64 * 1024 ||
      !['application_session', 'service_identity'].includes(snapshot.principalSource) ||
      !['application_lookup', 'not_applicable'].includes(snapshot.resourceSource) ||
      (snapshot.traceparent !== undefined &&
        (!traceparentPattern.test(snapshot.traceparent) ||
          /^00-0{32}-/.test(snapshot.traceparent) || /-0{16}-/.test(snapshot.traceparent)))) {
      throw new Error('Action contract is invalid');
    }
    if (snapshot.reviewSummary !== undefined && !validReviewSummary(snapshot.reviewSummary)) {
      throw new Error('Review summary is invalid');
    }
    return Object.freeze({ ...snapshot, requestId: randomUUID() });
  }

  /** Read the active bundle's processing requirements; this never authorizes an action. */
  async guardRequirements(operationVersionId: string, phase: Phase, traceparent?: string): Promise<unknown> {
    if (!uuid.test(operationVersionId) || !['tool_call', 'tool_result'].includes(phase) ||
      (traceparent !== undefined && (!traceparentPattern.test(traceparent) ||
        /^00-0{32}-/.test(traceparent) || /-0{16}-/.test(traceparent)))) {
      throw new Error('Guard requirements request is invalid');
    }
    const endpoint = new URL('/guard-requirements', this.#endpoint);
    endpoint.searchParams.set('operationVersionId', operationVersionId);
    endpoint.searchParams.set('phase', phase);
    const response = await this.#fetch(endpoint, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${this.#token}`,
        ...(traceparent ? { traceparent } : {}) }, signal: AbortSignal.timeout(4000) });
    if (response.status !== 200) throw new Error(`Sidecar returned HTTP ${response.status}`);
    return boundedJSON(response);
  }

  /** Signs one phase; callers enforcing a decision must apply the outcome themselves. */
  async evaluate(call: ObservedCall, phase: Phase, expectedMode: 'observe' | 'enforce',
    result?: unknown): Promise<ObserveDecision> {
    const attribution = {
      principalId: call.principalId,
      sessionId: call.sessionId,
      resourceId: call.resourceId ?? null,
      principalSource: call.principalSource,
      resourceSource: call.resourceSource,
    };
    const inputSha256 = createHash('sha256')
      .update(encodeInput(call, phase, result))
      .digest('hex');
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 30;
    if (call.reviewSummary && expectedMode !== 'enforce') {
      throw new Error('Review summary is only valid for an Enforce call');
    }
    const reviewSummarySha256 = call.reviewSummary && phase === 'tool_call' ? createHash('sha256')
      .update(JSON.stringify({ title: call.reviewSummary.title,
        fields: call.reviewSummary.fields.map(({ label, value }) => ({ label, value })) }))
      .digest('hex') : undefined;
    const statement = fields([
      ['type', goJSON('authrail.observe.executor.v1')],
      ['organisationId', goJSON(this.#organisationId)],
      ['deploymentId', goJSON(this.#deploymentId)],
      ['requestId', goJSON(call.requestId)],
      ['actionKey', goJSON(call.actionKey)],
      ['operationVersionId', goJSON(call.operationVersionId)],
      ['phase', goJSON(phase)],
      ['inputSha256', goJSON(inputSha256)],
      ['attribution', encodeAttribution(attribution)],
      ...(reviewSummarySha256 ? [['reviewSummarySha256', goJSON(reviewSummarySha256)] as [string, string]] : []),
      ['issuedAt', goJSON(issuedAt)],
      ['expiresAt', goJSON(expiresAt)],
    ]);
    const signature = sign(null, Buffer.from(statement), this.#privateKey).toString('base64url');
    const body = {
      formatVersion: 1,
      requestId: call.requestId,
      operationVersionId: call.operationVersionId,
      phase,
      arguments: call.arguments,
      ...(phase === 'tool_result' ? { result } : {}),
      ...(call.factResolutions?.length ? { factResolutions: call.factResolutions } : {}),
      ...(call.trajectory ? { trajectory: call.trajectory } : {}),
      ...(call.guardEvidence?.length ? { guardEvidence: call.guardEvidence } : {}),
      attribution,
      ...(reviewSummarySha256 ? { reviewSummary: call.reviewSummary } : {}),
      identityProof: { issuedAt, expiresAt, signature },
    };
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Idempotency-Key': call.actionKey,
        'Content-Type': 'application/json',
        ...(call.traceparent ? { traceparent: call.traceparent } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(expectedMode === 'enforce' ? 4000 : 2000),
    });
    if (response.status !== 200) throw new Error(`Sidecar returned HTTP ${response.status}`);
    const decision = await boundedJSON(response);
    if (
      !decision ||
      typeof decision !== 'object' ||
      Array.isArray(decision) ||
      !('requestId' in decision) ||
      decision.requestId !== call.requestId ||
      !('mode' in decision) ||
      decision.mode !== expectedMode ||
      !('enforced' in decision) ||
      !('coverage' in decision) ||
      !('outcome' in decision) ||
      decision.enforced !== false ||
      typeof decision.coverage !== 'string' ||
      typeof decision.outcome !== 'string' ||
      !coverage.has(decision.coverage) ||
      !outcomes.has(decision.outcome)
      || ('reportReplayed' in decision && typeof decision.reportReplayed !== 'boolean')
    ) {
      throw new Error('Sidecar decision contract is invalid');
    }
    return decision as ObserveDecision;
  }

  /** Claims an approved Action once. An uncertain response must be reconciled, never retried blindly. */
  async claimApproval(call: ObservedCall, decision: ObserveDecision): Promise<{
    permitId: string; actionId: string; expiresAt: string }> {
    return this.#approvalPermit(call, decision, false);
  }

  /** Reads an exact existing unstarted permit after an uncertain claim response. */
  async recoverApprovalPermit(call: ObservedCall, decision: ObserveDecision): Promise<{
    permitId: string; actionId: string; expiresAt: string }> {
    return this.#approvalPermit(call, decision, true);
  }

  async #approvalPermit(call: ObservedCall, decision: ObserveDecision,
    recoverExisting: boolean): Promise<{ permitId: string; actionId: string; expiresAt: string }> {
    if (decision.mode !== 'enforce' || decision.outcome !== 'approval_required' ||
      decision.recordingStatus !== 'retained' || decision.reportReplayed !== false ||
      !decision.actionId || !uuid.test(decision.actionId) ||
      !decision.approvalRequestId || !uuid.test(decision.approvalRequestId)) {
      throw new Error('A retained approval request is required');
    }
    const inputSha256 = createHash('sha256').update(encodeInput(call, 'tool_call')).digest('hex');
    const publicKey = createPublicKey(this.#privateKey).export({ format: 'jwk' });
    if (typeof publicKey.x !== 'string') throw new Error('Executor key is invalid');
    const keySha256 = createHash('sha256').update(Buffer.from(publicKey.x, 'base64url')).digest('hex');
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 30;
    const statement = fields([
      ['type', goJSON('authrail.approval.claim.v1')],
      ['organisationId', goJSON(this.#organisationId)],
      ['deploymentId', goJSON(this.#deploymentId)],
      ['approvalRequestId', goJSON(decision.approvalRequestId)],
      ['actionId', goJSON(decision.actionId)],
      ['inputSha256', goJSON(inputSha256)],
      ['keySha256', goJSON(keySha256)],
      ['issuedAt', goJSON(issuedAt)],
      ['expiresAt', goJSON(expiresAt)],
    ]);
    const signature = sign(null, Buffer.from(statement), this.#privateKey).toString('base64url');
    const response = await this.#fetch(new URL(recoverExisting
      ? '/approval-permits/recover' : '/approval-permits/claim', this.#endpoint), {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json',
        ...(call.traceparent ? { traceparent: call.traceparent } : {}) },
      body: JSON.stringify({ approvalRequestId: decision.approvalRequestId,
        actionId: decision.actionId, inputSha256, keySha256,
        proof: { issuedAt, expiresAt, signature } }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== (recoverExisting ? 200 : 201)) {
      throw new Error(`Approval permit returned HTTP ${response.status}`);
    }
    const permit = await boundedJSON(response);
    if (!permit || typeof permit !== 'object' || Array.isArray(permit) ||
      !('permitId' in permit) || typeof permit.permitId !== 'string' ||
      !uuid.test(permit.permitId) || !('actionId' in permit) ||
      permit.actionId !== decision.actionId || !('expiresAt' in permit) ||
      typeof permit.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(permit.expiresAt)) ||
      Date.parse(permit.expiresAt) <= Date.now()) {
      throw new Error('Approval permit response is invalid');
    }
    return permit as { permitId: string; actionId: string; expiresAt: string };
  }

  /** Reports explicit executor knowledge after an Observe attempt. Never pauses or authorizes the tool. */
  async reportObservedExecution(call: ObservedCall, outcome: ObservedExecutionOutcome): Promise<ObservedExecutionRecording> {
    if (!uuid.test(call.requestId) || !uuid.test(call.operationVersionId) || !reference.test(call.actionKey) ||
      !['succeeded', 'failed', 'unknown', 'reconciled_succeeded', 'reconciled_failed'].includes(outcome.event) ||
      typeof outcome.providerIdempotencyKey !== 'string' || !reference.test(outcome.providerIdempotencyKey) ||
      (outcome.providerReference !== null && (typeof outcome.providerReference !== 'string' || !reference.test(outcome.providerReference))) ||
      (outcome.event.startsWith('reconciled_') && outcome.providerReference === null)) {
      throw new Error('Observed execution outcome is invalid');
    }
    const inputSha256 = createHash('sha256').update(encodeInput(call, 'tool_call')).digest('hex');
    const publicKey = createPublicKey(this.#privateKey).export({ format: 'jwk' });
    if (typeof publicKey.x !== 'string') throw new Error('Executor key is invalid');
    const keySha256 = createHash('sha256').update(Buffer.from(publicKey.x, 'base64url')).digest('hex');
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 30;
    const statement = fields([
      ['type', goJSON('authrail.execution.receipt.observe.v1')], ['organisationId', goJSON(this.#organisationId)],
      ['deploymentId', goJSON(this.#deploymentId)], ['operationVersionId', goJSON(call.operationVersionId)],
      ['actionKey', goJSON(call.actionKey)], ['attemptId', goJSON(call.requestId)], ['event', goJSON(outcome.event)],
      ['inputSha256', goJSON(inputSha256)], ['providerIdempotencyKey', goJSON(outcome.providerIdempotencyKey)],
      ['providerReference', goJSON(outcome.providerReference)], ['keySha256', goJSON(keySha256)],
      ['issuedAt', goJSON(issuedAt)], ['expiresAt', goJSON(expiresAt)],
    ]);
    const signature = sign(null, Buffer.from(statement), this.#privateKey).toString('base64url');
    const response = await this.#fetch(new URL('/execution/observed-receipts', this.#endpoint), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(2000),
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `${call.operationVersionId}:${call.actionKey}:${call.requestId}:${outcome.event}`,
        ...(call.traceparent ? { traceparent: call.traceparent } : {}) },
      body: JSON.stringify({ operationVersionId: call.operationVersionId, actionKey: call.actionKey,
        attemptId: call.requestId, event: outcome.event, inputSha256,
        providerIdempotencyKey: outcome.providerIdempotencyKey, providerReference: outcome.providerReference,
        keySha256, proof: { issuedAt, expiresAt, signature } }),
    });
    if (response.status !== 201 && response.status !== 202) throw new Error('Observed outcome could not be recorded');
    const value = await boundedJSON(response);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('recordingStatus' in value)) {
      throw new Error('Observed outcome response is invalid');
    }
    if (response.status === 202 && value.recordingStatus === 'queued') return { recordingStatus: 'queued' };
    if (value.recordingStatus !== 'retained' || !('actionId' in value) || typeof value.actionId !== 'string' || !uuid.test(value.actionId) ||
      !('receiptId' in value) || typeof value.receiptId !== 'string' || !uuid.test(value.receiptId) ||
      !('state' in value) || !['succeeded', 'failed', 'outcome_unknown'].includes(String(value.state)) ||
      !('replayed' in value) || typeof value.replayed !== 'boolean') throw new Error('Observed outcome response is invalid');
    return value as ObservedExecutionRecording;
  }

  /** Signs one executor assertion; only the protected application can know the provider outcome. */
  async reportExecution(input: { actionId: string; attemptId: string;
    permitId: string | null; event: 'started' | 'succeeded' | 'failed' | 'unknown' |
      'reconciled_succeeded' | 'reconciled_failed'; inputSha256: string;
    providerIdempotencyKey: string; providerReference: string | null;
    traceparent?: string }): Promise<{
      receiptId: string; state: string; replayed: boolean }> {
    const publicKey = createPublicKey(this.#privateKey).export({ format: 'jwk' });
    if (typeof publicKey.x !== 'string') throw new Error('Executor key is invalid');
    const keySha256 = createHash('sha256').update(Buffer.from(publicKey.x, 'base64url')).digest('hex');
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 30;
    const statement = fields([
      ['type', goJSON('authrail.execution.receipt.v1')],
      ['organisationId', goJSON(this.#organisationId)],
      ['deploymentId', goJSON(this.#deploymentId)],
      ['actionId', goJSON(input.actionId)],
      ['attemptId', goJSON(input.attemptId)],
      ['permitId', goJSON(input.permitId)],
      ['event', goJSON(input.event)],
      ['inputSha256', goJSON(input.inputSha256)],
      ['providerIdempotencyKey', goJSON(input.providerIdempotencyKey)],
      ['providerReference', goJSON(input.providerReference)],
      ['keySha256', goJSON(keySha256)],
      ['issuedAt', goJSON(issuedAt)],
      ['expiresAt', goJSON(expiresAt)],
    ]);
    const signature = sign(null, Buffer.from(statement), this.#privateKey).toString('base64url');
    if (input.traceparent && (!traceparentPattern.test(input.traceparent) ||
      /^00-0{32}-/.test(input.traceparent) || /-0{16}-/.test(input.traceparent))) {
      throw new Error('Trace context is invalid');
    }
    const response = await this.#fetch(new URL('/execution-receipts', this.#endpoint), {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `${input.actionId}:${input.attemptId}:${input.event}`,
        ...(input.traceparent ? { traceparent: input.traceparent } : {}) },
      body: JSON.stringify({ actionId: input.actionId, attemptId: input.attemptId,
        permitId: input.permitId, event: input.event, inputSha256: input.inputSha256,
        providerIdempotencyKey: input.providerIdempotencyKey,
        providerReference: input.providerReference, keySha256,
        proof: { issuedAt, expiresAt, signature } }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 201) throw new Error(`Execution receipt returned HTTP ${response.status}`);
    const result = await boundedJSON(response);
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
      !('receiptId' in result) || typeof result.receiptId !== 'string' ||
      !uuid.test(result.receiptId) || !('state' in result) ||
      typeof result.state !== 'string' || !('replayed' in result) ||
      typeof result.replayed !== 'boolean') {
      throw new Error('Execution receipt response is invalid');
    }
    return result as { receiptId: string; state: string; replayed: boolean };
  }
}

function validReviewSummary(value: unknown): boolean {
  const safe = (text: unknown, max: number) => typeof text === 'string' &&
    text.length > 0 && Buffer.byteLength(text) <= max && text.trim() === text &&
    !/[\u0000-\u001f\u007f<>&\u2028\u2029]/.test(text);
  if (!jsonObject(value) || Object.keys(value).sort().join(',') !== 'fields,title' ||
    !safe(value.title, 120) || !Array.isArray(value.fields) ||
    value.fields.length < 1 || value.fields.length > 8) return false;
  return value.fields.every((field) => jsonObject(field) &&
    Object.keys(field).sort().join(',') === 'label,value' &&
    safe(field.label, 60) && safe(field.value, 200));
}
