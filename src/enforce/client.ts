import { createHash } from 'node:crypto';
import { ObserveClient } from '../observe/client.js';
import type { ObservedCall } from '../observe/protocol.js';
import { encodeInput, goJSON, jsonObject } from '../observe/protocol.js';
import type { JSONObject, ObserveClientConfig, ObserveDecision, ObserveOperation } from '../observe/types.js';

/** A blocked Enforce check. A result-phase block cannot undo an earlier tool effect. */
export class EnforceBlockedError extends Error {
  constructor(
    readonly phase: 'tool_call' | 'tool_result',
    readonly effectMayHaveOccurred: boolean,
    readonly decision: ObserveDecision | null,
    cause?: unknown,
  ) {
    super(`AuthRail blocked the ${phase === 'tool_call' ? 'tool call' : 'tool result'}`, { cause });
    this.name = 'EnforceBlockedError';
  }
}

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
  readonly #pending = new WeakMap<EnforceBlockedError,
    { call: ObservedCall; decision: ObserveDecision;
      execute: (checkedArguments: JSONObject, context: ExecutionContext) => JSONObject | Promise<JSONObject> }>();

  constructor(config: ObserveClientConfig) {
    this.#sidecar = new ObserveClient(config);
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
    try { callDecision = await this.#sidecar.evaluate(call, 'tool_call', 'enforce'); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    if (!permitted(callDecision)) {
      const blocked = new EnforceBlockedError('tool_call', false, callDecision);
      if (callDecision.outcome === 'approval_required' &&
        callDecision.recordingStatus === 'retained' &&
        callDecision.reportReplayed === false && callDecision.approvalRequestId) {
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
    try { resultDecision = await this.#sidecar.evaluate(call, 'tool_result', 'enforce', result); }
    catch (cause) { throw new EnforceBlockedError('tool_result', true, null, cause); }
    if (!permitted(resultDecision)) throw new EnforceBlockedError('tool_result', true, resultDecision);
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
