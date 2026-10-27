import { createHash } from 'node:crypto';
import { ObserveClient } from '../observe/client.js';
import type { ObservedCall } from '../observe/protocol.js';
import { encodeInput, goJSON, jsonObject } from '../observe/protocol.js';
import { processGuard, registeredHandlers } from './guard.js';
import type { GuardHandler, JSONObject, ObserveClientConfig, ObserveDecision, ObserveOperation } from '../observe/types.js';

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
};

/** The protected function failed after permission; its external effect is unknown. */
export class EnforceOutcomeUnknownError extends Error {
  readonly effectMayHaveOccurred = true;

  constructor(cause: unknown, readonly recovery?: { actionId: string; attemptId: string;
    permitId: string | null; inputSha256: string; providerIdempotencyKey: string }) {
    super('Protected tool outcome is unknown; reconcile before retrying', { cause });
    this.name = 'EnforceOutcomeUnknownError';
  }
}

/** Runs only explicitly allowed calls and withholds results that fail their check. */
export class EnforceClient {
  readonly #sidecar: ObserveClient;
  readonly #handlers: Map<string, GuardHandler>;
  readonly #guardProcessing: boolean;
  readonly #pending = new WeakMap<EnforceBlockedError,
    { call: ObservedCall; decision: ObserveDecision;
      execute: (checkedArguments: JSONObject, context: ExecutionContext) => JSONObject | Promise<JSONObject> }>();

  constructor(config: ObserveClientConfig) {
    this.#sidecar = new ObserveClient(config);
    this.#handlers = registeredHandlers(config.guardHandlers);
    this.#guardProcessing = config.guardHandlers !== undefined;
  }

  async enforce<Result extends JSONObject>(
    operation: ObserveOperation,
    argumentsValue: JSONObject,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
  ): Promise<{ result: Result; callDecision: ObserveDecision; resultDecision: ObserveDecision }> {
    if (typeof execute !== 'function') throw new Error('Protected tool function is required');
    let call;
    try { call = this.#sidecar.prepare(operation, argumentsValue); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    let callDecision: ObserveDecision;
    try {
      let bundleId: string | undefined;
      if (this.#guardProcessing) {
        const processed = await processGuard(
          await this.#sidecar.guardRequirements(call.operationVersionId, 'tool_call'),
          call.operationVersionId, 'tool_call', call.arguments, this.#handlers);
        call = { ...call, arguments: processed.output, guardEvidence: processed.evidence };
        bundleId = processed.bundleId;
      }
      callDecision = await this.#sidecar.evaluate(call, 'tool_call', 'enforce');
      if (bundleId && callDecision.bundleId !== bundleId) throw new Error('Guard bundle changed');
    } catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    if (!permitted(callDecision)) {
      const continuable = callDecision.outcome === 'approval_required' &&
        callDecision.recordingStatus === 'retained' &&
        callDecision.reportReplayed === false && !!callDecision.approvalRequestId &&
        !!callDecision.actionId;
      const blocked = new EnforceBlockedError('tool_call', false, callDecision, undefined,
        continuable ? { call, decision: callDecision } : undefined);
      if (continuable) {
        this.#pending.set(blocked, { call, decision: callDecision, execute });
      }
      throw blocked;
    }

    const { result, resultDecision } = await this.#execute(call, execute, callDecision, null);
    return { result, callDecision, resultDecision };
  }

  /** Resumes the original protected function only after a one-use permit claim. */
  async resumeApproval(
    blocked: EnforceBlockedError,
  ): Promise<{ result: JSONObject; permitId: string; resultDecision: ObserveDecision }> {
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
      pending.call, pending.execute, pending.decision, permit.permitId);
    return { result, permitId: permit.permitId, resultDecision };
  }

  /** Resume an approved call after a process or request boundary using protected persisted state. */
  async resumeApprovalFrom<Result extends JSONObject>(
    continuation: ApprovalContinuation,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
  ): Promise<{ result: Result; permitId: string; resultDecision: ObserveDecision }> {
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
    const { result, resultDecision } = await this.#execute(call, execute, decision, permit.permitId);
    return { result, permitId: permit.permitId, resultDecision };
  }

  /** Resumes only with an existing unexpired permit proven by the control plane. */
  async recoverApprovalFrom<Result extends JSONObject>(
    continuation: ApprovalContinuation,
    execute: (checkedArguments: JSONObject, context: ExecutionContext) => Result | Promise<Result>,
  ): Promise<{ result: Result; permitId: string; resultDecision: ObserveDecision }> {
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
    const { result, resultDecision } = await this.#execute(call, execute, decision, permit.permitId);
    return { result, permitId: permit.permitId, resultDecision };
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
    decision: ObserveDecision, permitId: string | null) {
    if (!decision.actionId) throw new EnforceBlockedError('tool_call', false, decision);
    const recovery = { actionId: decision.actionId, attemptId: call.requestId, permitId,
      inputSha256: createHash('sha256').update(encodeInput(call, 'tool_call')).digest('hex'),
      providerIdempotencyKey: `ar-${decision.actionId}`, traceparent: call.traceparent };
    try {
      const started = await this.#sidecar.reportExecution({ ...recovery,
        event: 'started', providerReference: null });
      if (started.state !== 'executing' || started.replayed) {
        throw new Error('Execution start was not fresh');
      }
    } catch (cause) {
      // A lost acknowledgement cannot authorize a provider call.
      throw new EnforceBlockedError('tool_call', false, decision, cause);
    }
    // Only the protected application receives this callback and provider credentials.
    // The SDK cannot prove that a separate agent path cannot reach the same effect.
    let result: Result;
    try { result = await execute(call.arguments, recovery) as Result; }
    catch (cause) {
      try { await this.#sidecar.reportExecution({ ...recovery,
        event: 'unknown', providerReference: null }); } catch { /* recovery remains required */ }
      throw new EnforceOutcomeUnknownError(cause, recovery);
    }
    try {
      const completed = await this.#sidecar.reportExecution({ ...recovery,
        event: 'succeeded', providerReference: null });
      if (completed.state !== 'succeeded') throw new Error('Completion was not retained as succeeded');
    } catch (cause) { throw new EnforceOutcomeUnknownError(cause, recovery); }
    let bounded = false;
    try { bounded = jsonObject(result) && Buffer.byteLength(goJSON(result)) <= 64 * 1024; }
    catch { bounded = false; }
    if (!bounded) {
      throw new EnforceBlockedError('tool_result', true, null,
        new Error('Tool result is not a bounded JSON object'));
    }
    let resultDecision: ObserveDecision;
    try {
      let resultCall = call;
      let bundleId: string | undefined;
      if (this.#guardProcessing) {
        const processed = await processGuard(
          await this.#sidecar.guardRequirements(call.operationVersionId, 'tool_result'),
          call.operationVersionId, 'tool_result', result, this.#handlers);
        const guardEvidence = [...(call.guardEvidence ?? []), ...processed.evidence];
        if (guardEvidence.length > 128) throw new Error('Guard processing evidence is too large');
        resultCall = { ...call, guardEvidence };
        result = processed.output as Result;
        bundleId = processed.bundleId;
      }
      resultDecision = await this.#sidecar.evaluate(resultCall, 'tool_result', 'enforce', result);
      if (bundleId && resultDecision.bundleId !== bundleId) throw new Error('Guard bundle changed');
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
