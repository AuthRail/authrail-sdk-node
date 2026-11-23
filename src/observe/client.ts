import { registeredDataSources, resolveData, type DataSourceBinding } from './data.js';
import { createHash, createPrivateKey, createPublicKey, KeyObject, randomUUID, sign } from 'node:crypto';
import type { ObservedCall, Phase, ExpectedBundle } from './protocol.js';
import {
  ConfigurationChangedError,
  boundedJSON,
  encodeAttribution,
  encodeInput,
  fields,
  freezeContext,
  goJSON,
  jsonObject,
  MAX_EVALUATION_REQUEST_BYTES,
} from './protocol.js';
import { readContextual, type ContextualConnection } from './contextual.js';
import type {
  JSONObject,
  Observation,
  ObserveClientConfig,
  ObserveDecision,
  ObserveOperation,
  ObservedExecutionOutcome,
  ObservedExecutionRecording,
  TrajectorySession,
} from './types.js';

export type ApprovalStatus = { actionId: string; approvalRequestId: string;
  state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'consumed' | 'superseded' | 'permit_issued';
  requiresRefresh: boolean; expiresAt: string };

type Checked = { decision: ObserveDecision | null; error: unknown };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reference = /^[A-Za-z0-9._:-]{1,128}$/;
function validProviderReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4000 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value).toString('utf8') === value;
}
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
  #contextual: ContextualConnection;
  #dataSources: DataSourceBinding[] | undefined;
  #dataCalls = new WeakMap<ObservedCall, ObservedCall>();

  constructor(config: ObserveClientConfig) {
    const url = new URL(config.sidecarUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
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
    this.#dataSources = registeredDataSources(config.dataSources);
    this.#endpoint = new URL('/evaluate', url);
    this.#token = config.adapterToken;
    this.#organisationId = config.organisationId;
    this.#deploymentId = config.deploymentId;
    this.#privateKey = privateKey;
    this.#fetch = config.fetch ?? fetch;
    this.#contextual = { sidecarUrl: url.origin, adapterToken: this.#token,
      organisationId: this.#organisationId, deploymentId: this.#deploymentId,
      executorPrivateKey: privateKey, fetch: this.#fetch };
  }

  /** Admit or inspect one active session; never creates a generation from caller input. */
  async admitTrajectorySession(principalId: string, sessionId: string): Promise<TrajectorySession> {
    if (!reference.test(principalId) || !reference.test(sessionId)) throw new Error('Trajectory identity is invalid');
    const value = await this.#trajectoryRequest('/trajectory/sessions', { principalId, sessionId });
    if (!jsonObject(value) || value.principalId !== principalId || value.sessionId !== sessionId ||
      typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation <= 0 ||
      typeof value.nextSequence !== 'number' || !Number.isSafeInteger(value.nextSequence) || value.nextSequence <= 0) throw new Error('Trajectory admission response is invalid');
    return { principalId, sessionId, generation: value.generation, nextSequence: value.nextSequence };
  }

  /** End an exact generation. Pending evidence and unknown business effects remain retained. */
  async retireTrajectorySession(session: Pick<TrajectorySession, 'principalId' | 'sessionId' | 'generation'>): Promise<void> {
    if (!reference.test(session.principalId) || !reference.test(session.sessionId) || !Number.isSafeInteger(session.generation) || session.generation <= 0) throw new Error('Trajectory retirement is invalid');
    await this.#trajectoryRequest('/trajectory/sessions/retire', { principalId: session.principalId, sessionId: session.sessionId, generation: session.generation }, 204);
  }

  /** Explicitly disable legacy session admissions and retire their local histories. */
  async migrateLegacyTrajectorySessions(): Promise<{ legacyDisabled: true; retiredLegacySessions: number }> {
    const value = await this.#trajectoryRequest('/trajectory/sessions/migrate-legacy', { disableLegacy: true });
    if (!jsonObject(value) || value.legacyDisabled !== true || typeof value.retiredLegacySessions !== 'number' ||
      !Number.isSafeInteger(value.retiredLegacySessions) || value.retiredLegacySessions < 0 || value.retiredLegacySessions > 128) throw new Error('Trajectory migration response is invalid');
    return { legacyDisabled: true, retiredLegacySessions: value.retiredLegacySessions };
  }

  async #trajectoryRequest(path: string, body: object, status = 200): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#endpoint), { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(2000), headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (response.status !== status) throw new Error(`Trajectory lifecycle returned HTTP ${response.status}`);
    return status === 204 ? undefined : boundedJSON(response);
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
    result?: unknown, expectedBundle?: ExpectedBundle, refreshRetainedFacts = false): Promise<ObserveDecision> {
    const originalCall = call;
    let data = this.#dataSources !== undefined
      ? await resolveData(this.#contextual, this.#dataSources, call, phase, refreshRetainedFacts, expectedBundle)
      : { resolutions: call.factResolutions, bundleId: undefined, sequence: undefined, hasManagedRequirements: false };
    call = { ...call, ...(data.resolutions ? { factResolutions: data.resolutions } : {}) };
    if (expectedBundle && data.bundleId && (expectedBundle.bundleId !== data.bundleId || expectedBundle.sequence !== data.sequence)) throw new ConfigurationChangedError();
    expectedBundle ??= data.bundleId ? { bundleId: data.bundleId, sequence: data.sequence! } : undefined;
    const preparedInput = encodeInput(call, phase, result);
    let contextualFindings = await readContextual(this.#contextual, call, phase, result, expectedBundle);
    if (this.#dataSources !== undefined && data.hasManagedRequirements && contextualFindings.length) {
      // Slow classifications must not age managed facts before authorization.
      // Findings are requested again for a changed input; never cache or re-sign them here.
      data = await resolveData(this.#contextual, this.#dataSources, call, phase, true, expectedBundle);
      if (expectedBundle && (data.bundleId !== expectedBundle.bundleId || data.sequence !== expectedBundle.sequence)) throw new ConfigurationChangedError();
      call = { ...call, ...(data.resolutions ? { factResolutions: data.resolutions } : {}) };
      if (encodeInput(call, phase, result) !== preparedInput) {
        contextualFindings = await readContextual(this.#contextual, call, phase, result, expectedBundle);
      }
    }
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
      ...(expectedBundle ? { expectedBundle } : {}),
      requestId: call.requestId,
      operationVersionId: call.operationVersionId,
      phase,
      arguments: call.arguments,
      ...(phase === 'tool_result' ? { result } : {}),
      ...(call.factResolutions?.length ? { factResolutions: call.factResolutions } : {}),
      ...(call.trajectory ? { trajectory: call.trajectory } : {}),
      ...(call.guardEvidence?.length ? { guardEvidence: call.guardEvidence } : {}),
      ...(contextualFindings.length ? { contextualFindings } : {}),
      attribution,
      ...(reviewSummarySha256 ? { reviewSummary: call.reviewSummary } : {}),
      identityProof: { issuedAt, expiresAt, signature },
    };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_EVALUATION_REQUEST_BYTES) {
      throw new Error('Evaluation request exceeds its size limit');
    }
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Idempotency-Key': call.actionKey,
        'Content-Type': 'application/json',
        ...(call.traceparent ? { traceparent: call.traceparent } : {}),
      },
      body: encoded,
      // Enforce waits for durable decision delivery before the protected function runs.
      // Leave room for the sidecar's bounded recording window; Observe stays short.
      signal: AbortSignal.timeout(expectedMode === 'enforce' ? 10000 : 2000),
    });
    if (response.status === 409) {
      const conflict = await boundedJSON(response);
      if (jsonObject(conflict) && Object.keys(conflict).length === 1 && conflict.code === 'configuration_changed') throw new ConfigurationChangedError();
    }
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
    if (data.bundleId && (!('bundleId' in decision) || decision.bundleId !== data.bundleId || !('sequence' in decision) || decision.sequence !== data.sequence)) {
      throw new Error('Data source bundle changed');
    }
    if (phase === 'tool_call' && this.#dataSources !== undefined) this.#dataCalls.set(originalCall, call);
    return decision as ObserveDecision;
  }

  /** Return the detached checked call, including facts bound into its signature and receipts. */
  checkedCall(call: ObservedCall): ObservedCall { return this.#dataCalls.get(call) ?? call; }

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

  async #approvalRequest(call: ObservedCall, decision: ObserveDecision, operation: 'claim' | 'recover' | 'status'): Promise<unknown> {
    if (decision.mode !== 'enforce' || decision.outcome !== 'approval_required' ||
      decision.recordingStatus !== 'retained' || decision.reportReplayed !== false ||
      !decision.actionId || !uuid.test(decision.actionId) ||
      !decision.approvalRequestId || !uuid.test(decision.approvalRequestId)) {
      throw new Error('A retained approval request is required');
    }
    call = this.checkedCall(call);
    const inputSha256 = createHash('sha256').update(encodeInput(call, 'tool_call')).digest('hex');
    const publicKey = createPublicKey(this.#privateKey).export({ format: 'jwk' });
    if (typeof publicKey.x !== 'string') throw new Error('Executor key is invalid');
    const keySha256 = createHash('sha256').update(Buffer.from(publicKey.x, 'base64url')).digest('hex');
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 30;
    const statement = fields([
      ['type', goJSON(operation === 'status' ? 'authrail.approval.status.v1' : 'authrail.approval.claim.v1')],
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
    const response = await this.#fetch(new URL(`/approval-permits/${operation}`, this.#endpoint), {
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json',
        ...(call.traceparent ? { traceparent: call.traceparent } : {}) },
      body: JSON.stringify({ approvalRequestId: decision.approvalRequestId,
        actionId: decision.actionId, inputSha256, keySha256,
        proof: { issuedAt, expiresAt, signature } }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== (operation === 'claim' ? 201 : 200)) {
      throw new Error(`Approval permit returned HTTP ${response.status}`);
    }
    return boundedJSON(response);
  }

  /** Durable waiting state is independent of short-lived review freshness. */
  async approvalStatus(call: ObservedCall, decision: ObserveDecision): Promise<ApprovalStatus> {
    const value = await this.#approvalRequest(call, decision, 'status');
    if (!jsonObject(value) || Object.keys(value).length !== 5 || value.actionId !== decision.actionId || value.approvalRequestId !== decision.approvalRequestId ||
      !['pending','approved','rejected','cancelled','expired','consumed','superseded','permit_issued'].includes(String(value.state)) ||
      typeof value.requiresRefresh !== 'boolean' || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('Approval status response is invalid');
    return value as ApprovalStatus;
  }

  async #approvalPermit(call: ObservedCall, decision: ObserveDecision, recoverExisting: boolean): Promise<{ permitId: string; actionId: string; expiresAt: string }> {
    const permit = await this.#approvalRequest(call, decision, recoverExisting ? 'recover' : 'claim');
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
      (outcome.providerReference !== null && !validProviderReference(outcome.providerReference)) ||
      (outcome.event.startsWith('reconciled_') && outcome.providerReference === null)) {
      throw new Error('Observed execution outcome is invalid');
    }
    call = this.checkedCall(call);
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
    if (!uuid.test(input.actionId) || !uuid.test(input.attemptId) || (input.permitId !== null && !uuid.test(input.permitId)) ||
      !/^[0-9a-f]{64}$/.test(input.inputSha256) || !reference.test(input.providerIdempotencyKey) ||
      !['started','succeeded','failed','unknown','reconciled_succeeded','reconciled_failed'].includes(input.event) ||
      (input.providerReference !== null && !validProviderReference(input.providerReference)) ||
      (input.event === 'started' && input.providerReference !== null) || (input.event.startsWith('reconciled_') && input.providerReference === null)) throw new Error('Execution evidence is invalid');
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
