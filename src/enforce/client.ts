import { createHash, randomUUID } from 'node:crypto';
import { ObserveClient } from '../observe/client.js';
import type { ObservedCall } from '../observe/protocol.js';
import { ConfigurationChangedError, encodeInput, freezeContext, goJSON, jsonObject } from '../observe/protocol.js';
import { processGuard, registeredHandlers } from './guard.js';
import type { FactResolution, TrajectorySnapshot, GuardHandler, JSONObject, ObserveClientConfig, ObserveDecision, ObserveOperation } from '../observe/types.js';

/** A blocked Enforce check. A result-phase block cannot undo an earlier tool effect. */
export class EnforceBlockedError extends Error {
  constructor(
    readonly phase: 'tool_call' | 'tool_result',
    readonly effectMayHaveOccurred: boolean,
    readonly decision: ObserveDecision | null,
    cause?: unknown,
    /** Persist only in protected application storage for a later approved retry. */
    readonly approvalContinuation?: ApprovalContinuation,
  ) {
    super(`AuthRail blocked the ${phase === 'tool_call' ? 'tool call' : 'tool result'}`, { cause });
    this.name = 'EnforceBlockedError';
  }
}

/** Exact pending call and retained decision; the protected app must encrypt and scope it. */
export type ApprovalContinuation = {
  call: ObservedCall;
  decision: ObserveDecision;
  /** Original private input permits fresh processing without transforming twice. */
  originalArguments?: JSONObject;
};

/** Execution ownership or its external outcome is uncertain; never retry the effect blindly. */
export class EnforceOutcomeUnknownError extends Error {
  readonly effectMayHaveOccurred = true;

  constructor(cause: unknown, readonly recovery?: ExecutionContext,
    readonly callDecision?: ObserveDecision) {
    super('Protected tool outcome is unknown; reconcile before retrying', { cause });
    this.name = 'EnforceOutcomeUnknownError';
  }
}

/** Runs only explicitly allowed calls and withholds results that fail their check. */
export class EnforceClient {
  readonly #sidecar: ObserveClient;
  readonly #handlers: Map<string, GuardHandler>;
  readonly #pending = new WeakMap<EnforceBlockedError,
    { call: ObservedCall; decision: ObserveDecision; originalArguments: JSONObject;
      execute: (checkedArguments: JSONObject, context: ExecutionContext) => JSONObject | Promise<JSONObject> }>();

  constructor(config: ObserveClientConfig) {
    this.#sidecar = new ObserveClient(config);
    this.#handlers = registeredHandlers(config.guardHandlers);
  }

  async enforce<Result extends JSONObject>(
    operation: ObserveOperation,
    argumentsValue: JSONObject,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
    options?: ExecutionOptions,
  ): Promise<{ result: Result; callDecision: ObserveDecision; resultDecision: ObserveDecision }> {
    const checkpoint = options?.executionCheckpoint;
    if (typeof execute !== 'function') throw new Error('Protected tool function is required');
    let call;
    try { call = this.#sidecar.prepare(operation, argumentsValue); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    const originalArguments = freezeContext(call.arguments);
    let callDecision: ObserveDecision;
    try { ({ call, decision: callDecision } = await this.#checkCall(call, originalArguments)); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    if (!permitted(callDecision)) {
      const continuable = callDecision.outcome === 'approval_required' &&
        callDecision.recordingStatus === 'retained' &&
        callDecision.reportReplayed === false && !!callDecision.approvalRequestId &&
        !!callDecision.actionId;
      const blocked = new EnforceBlockedError('tool_call', false, callDecision, undefined,
        continuable ? { call, decision: callDecision, originalArguments } : undefined);
      if (continuable) {
        this.#pending.set(blocked, { call, decision: callDecision, execute, originalArguments });
      }
      throw blocked;
    }

    const { result, resultDecision } = await this.#execute(call, execute, callDecision, null, checkpoint, originalArguments);
    return { result, callDecision, resultDecision };
  }

  /** Resumes the original protected function only after a one-use permit claim. */
  async resumeApproval(
    blocked: EnforceBlockedError,
    options?: ExecutionOptions,
  ): Promise<{ result: JSONObject; permitId: string; resultDecision: ObserveDecision }> {
    const checkpoint = options?.executionCheckpoint;
    const pending = this.#pending.get(blocked);
    if (!pending) {
      throw new EnforceBlockedError('tool_call', false, blocked.decision);
    }
    this.#pending.delete(blocked);
    let permit: { permitId: string; actionId: string; expiresAt: string };
    try { permit = await this.#sidecar.claimApproval(pending.call, pending.decision); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, pending.decision, cause); }
    if (Date.parse(permit.expiresAt) <= Date.now()) {
      throw new EnforceBlockedError('tool_call', false, pending.decision);
    }
    const { result, resultDecision } = await this.#execute(
      pending.call, pending.execute, pending.decision, permit.permitId, checkpoint, pending.originalArguments);
    return { result, permitId: permit.permitId, resultDecision };
  }

  /** Resume an approved call after a process or request boundary using protected persisted state. */
  async resumeApprovalFrom<Result extends JSONObject>(
    continuation: ApprovalContinuation,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
    options?: ExecutionOptions,
  ): Promise<{ result: Result; permitId: string; resultDecision: ObserveDecision }> {
    const checkpoint = options?.executionCheckpoint;
    if (typeof execute !== 'function' || !continuation ||
      !continuation.call || !continuation.decision) {
      throw new EnforceBlockedError('tool_call', false, null);
    }
    const { call, decision } = continuation;
    let permit: { permitId: string; actionId: string; expiresAt: string };
    try { permit = await this.#sidecar.claimApproval(call, decision); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, decision, cause); }
    if (Date.parse(permit.expiresAt) <= Date.now()) {
      throw new EnforceBlockedError('tool_call', false, decision);
    }
    const { result, resultDecision } = await this.#execute(call, execute, decision, permit.permitId, checkpoint, continuation.originalArguments);
    return { result, permitId: permit.permitId, resultDecision };
  }

  /** Resumes only with an existing unexpired permit proven by the control plane. */
  async recoverApprovalFrom<Result extends JSONObject>(
    continuation: ApprovalContinuation,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
    options?: ExecutionOptions,
  ): Promise<{ result: Result; permitId: string; resultDecision: ObserveDecision }> {
    const checkpoint = options?.executionCheckpoint;
    if (typeof execute !== 'function' || !continuation ||
      !continuation.call || !continuation.decision) {
      throw new EnforceBlockedError('tool_call', false, null);
    }
    const { call, decision } = continuation;
    let permit: { permitId: string; actionId: string; expiresAt: string };
    try { permit = await this.#sidecar.recoverApprovalPermit(call, decision); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, decision, cause); }
    if (Date.parse(permit.expiresAt) <= Date.now()) {
      throw new EnforceBlockedError('tool_call', false, decision);
    }
    const { result, resultDecision } = await this.#execute(call, execute, decision, permit.permitId, checkpoint, continuation.originalArguments);
    return { result, permitId: permit.permitId, resultDecision };
  }

  async approvalStatus(continuation: ApprovalContinuation) {
    return this.#sidecar.approvalStatus(continuation.call, continuation.decision);
  }

  /** Explicit fresh review; prior votes and an unknown effect never become new permission. */
  async refreshApprovalFrom<Result extends JSONObject>(continuation: ApprovalContinuation,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
    options?: RefreshApprovalOptions): Promise<{ result: Result; callDecision: ObserveDecision; resultDecision: ObserveDecision }> {
    const status = await this.approvalStatus(continuation);
    if (!status.requiresRefresh || !['pending','approved','permit_issued'].includes(status.state)) throw new EnforceBlockedError('tool_call', false, continuation.decision);
    if (!continuation.originalArguments && continuation.call.guardEvidence?.length) throw new Error('Original input is required for fresh Guard processing');
    const originalArguments = freezeContext(continuation.originalArguments ?? continuation.call.arguments);
    const fresh = { ...continuation.call, requestId: randomUUID(),
      ...(options?.factResolutions ? { factResolutions: freezeContext({ facts: options.factResolutions }).facts as FactResolution[] } : {}),
      ...(options?.trajectory ? { trajectory: freezeContext(options.trajectory) } : {}) };
    const { call, decision } = await this.#checkCall(fresh, originalArguments, continuation.call.arguments);
    if (goJSON(call.arguments) !== goJSON(continuation.call.arguments)) throw new EnforceBlockedError('tool_call', false, decision, new Error('Fresh processing changed the business input'));
    if (!permitted(decision)) throw new EnforceBlockedError('tool_call', false, decision, undefined,
      decision.outcome === 'approval_required' && decision.recordingStatus === 'retained' && decision.reportReplayed === false
        ? { call, decision, originalArguments } : undefined);
    const { result, resultDecision } = await this.#execute(call, execute, decision, null, options?.executionCheckpoint, originalArguments);
    return { result, callDecision: decision, resultDecision };
  }

  async #checkCall(base: ObservedCall, originalArguments: JSONObject, expectedArguments?: JSONObject) {
    for (let attempt = 0; ; attempt++) {
      try {
        const processed = await processGuard(await this.#sidecar.guardRequirements(base.operationVersionId, 'tool_call', base.traceparent), base.operationVersionId, 'tool_call', originalArguments, this.#handlers);
        if (expectedArguments && goJSON(processed.output) !== goJSON(expectedArguments)) throw new Error('Fresh processing changed the business input');
        const prepared = { ...base, arguments: processed.output, guardEvidence: processed.evidence };
        const decision = await this.#sidecar.evaluate(prepared, 'tool_call', 'enforce', undefined, { bundleId: processed.bundleId, sequence: processed.sequence }, expectedArguments !== undefined);
        const call = this.#sidecar.checkedCall(prepared);
        if (decision.bundleId !== processed.bundleId || decision.sequence !== processed.sequence) throw new Error('Guard bundle changed after evaluation');
        return { call, decision };
      } catch (cause) { if (attempt === 0 && cause instanceof ConfigurationChangedError) continue; throw cause; }
    }
  }

  /** Resolves an uncertain attempt only after the executor has checked the provider by idempotency key. */
  async reconcile(input: { actionId: string; attemptId: string; permitId: string | null;
    inputSha256: string; providerIdempotencyKey: string;
    providerReference: string; outcome: 'succeeded' | 'failed'; traceparent?: string }) {
    return this.#sidecar.reportExecution({ actionId: input.actionId,
      attemptId: input.attemptId, permitId: input.permitId,
      inputSha256: input.inputSha256,
      providerIdempotencyKey: input.providerIdempotencyKey,
      providerReference: input.providerReference, traceparent: input.traceparent,
      event: input.outcome === 'succeeded' ? 'reconciled_succeeded' : 'reconciled_failed' });
  }

  async #execute<Result extends JSONObject>(call: ObservedCall,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
    decision: ObserveDecision, permitId: string | null, checkpoint?: ExecutionCheckpoint, originalArguments?: JSONObject) {
    if (!decision.actionId) throw new EnforceBlockedError('tool_call', false, decision);
    const recovery = { actionId: decision.actionId, attemptId: call.requestId, permitId,
      inputSha256: createHash('sha256').update(encodeInput(call, 'tool_call')).digest('hex'),
      providerIdempotencyKey: `ar-${decision.actionId}`, traceparent: call.traceparent };
    try {
      // Persist a detached identity before a start request can become uncertain.
      if (checkpoint !== undefined) await checkpoint(Object.freeze({ ...recovery }));
    } catch (cause) { throw new EnforceBlockedError('tool_call', false, decision, cause); }
    try {
      const started = await this.#sidecar.reportExecution({ ...recovery,
        event: 'started', providerReference: null });
      if (started.state !== 'executing' || started.replayed) {
        throw new Error('Execution start was not fresh');
      }
    } catch (cause) {
      // A lost or replayed start withholds this callback but retains original work identity.
      throw new EnforceOutcomeUnknownError(cause, recovery, decision);
    }
    // Only the protected application receives this callback and provider credentials.
    // The SDK cannot prove that a separate agent path cannot reach the same effect.
    let result: Result;
    // Application-local mutation must not rewrite the signed call or receipt identity.
    try { result = await execute(freezeContext(call.arguments), { ...recovery }) as Result; }
    catch (cause) {
      try { await this.#sidecar.reportExecution({ ...recovery,
        event: 'unknown', providerReference: null }); } catch { /* recovery remains required */ }
      throw new EnforceOutcomeUnknownError(cause, recovery, decision);
    }
    try {
      const completed = await this.#sidecar.reportExecution({ ...recovery,
        event: 'succeeded', providerReference: null });
      if (completed.state !== 'succeeded') throw new Error('Completion was not retained as succeeded');
    } catch (cause) { throw new EnforceOutcomeUnknownError(cause, recovery, decision); }
    let bounded = false;
    try { bounded = jsonObject(result) && Buffer.byteLength(goJSON(result)) <= 64 * 1024; }
    catch { bounded = false; }
    if (!bounded) {
      throw new EnforceBlockedError('tool_result', true, null,
        new Error('Tool result is not a bounded JSON object'));
    }
    let resultDecision: ObserveDecision;
    const rawResult = freezeContext(result);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const processed = await processGuard(await this.#sidecar.guardRequirements(call.operationVersionId, 'tool_result', call.traceparent), call.operationVersionId, 'tool_result', rawResult, this.#handlers);
          let preparedCall = call;
          if (originalArguments && (processed.bundleId !== decision.bundleId || processed.sequence !== decision.sequence)) {
            const freshCall = await processGuard(await this.#sidecar.guardRequirements(call.operationVersionId, 'tool_call', call.traceparent), call.operationVersionId, 'tool_call', originalArguments, this.#handlers);
            if (freshCall.bundleId !== processed.bundleId || freshCall.sequence !== processed.sequence) throw new ConfigurationChangedError();
            if (goJSON(freshCall.output) !== goJSON(call.arguments)) throw new Error('Current processing changed the executed business input');
            preparedCall = { ...call, guardEvidence: freshCall.evidence };
          }
          const guardEvidence = [...(preparedCall.guardEvidence ?? []).filter(proof => proof.phase === 'tool_call'), ...processed.evidence];
          if (guardEvidence.length > 128) throw new Error('Guard processing evidence is too large');
          resultDecision = await this.#sidecar.evaluate({ ...preparedCall, guardEvidence }, 'tool_result', 'enforce', processed.output, { bundleId: processed.bundleId, sequence: processed.sequence });
          if (resultDecision.bundleId !== processed.bundleId || resultDecision.sequence !== processed.sequence) throw new Error('Guard bundle changed after evaluation');
          result = processed.output as Result;
          break;
        } catch (cause) { if (attempt === 0 && cause instanceof ConfigurationChangedError) continue; throw cause; }
      }
    } catch (cause) { throw new EnforceBlockedError('tool_result', true, null, cause); }
    if (!permittedResult(resultDecision, decision, permitId)) {
      throw new EnforceBlockedError('tool_result', true, resultDecision);
    }
    return { result, resultDecision };
  }
}

/** Persist this identity with the provider request so restart recovery can query its outcome. */
export type ExecutionContext = { actionId: string; attemptId: string;
  permitId: string | null; inputSha256: string; providerIdempotencyKey: string;
  traceparent?: string };

/** Save only in protected application storage; a rejection prevents execution start. */
export type ExecutionCheckpoint = (context: Readonly<ExecutionContext>) => void | Promise<void>;

/** Per-invocation persistence; never changes other requests on the same client. */
export type ExecutionOptions = { executionCheckpoint?: ExecutionCheckpoint };
/** Explicit current manual context; automatic Data sources are reread during refresh. */
export type RefreshApprovalOptions = ExecutionOptions & { factResolutions?: FactResolution[]; trajectory?: TrajectorySnapshot };

function permitted(decision: ObserveDecision): boolean {
  return decision.mode === 'enforce' && decision.enforced === false &&
    decision.coverage === 'evaluated' && decision.outcome === 'allow' &&
    decision.recordingStatus === 'retained' && decision.reportReplayed === false;
}

function permittedResult(result: ObserveDecision, call: ObserveDecision,
  permitId: string | null): boolean {
  if (permitted(result)) return result.actionId === call.actionId;
  // Policy approval is re-evaluated at the result hook. Only the exact Action
  // whose one-use permit was already claimed may release that result.
  return permitId !== null && call.outcome === 'approval_required' &&
    result.mode === 'enforce' && result.enforced === false &&
    result.coverage === 'evaluated' && result.outcome === 'approval_required' &&
    result.recordingStatus === 'retained' && result.reportReplayed === false &&
    !!call.actionId && result.actionId === call.actionId;
}
