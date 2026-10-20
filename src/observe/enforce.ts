import { ObserveClient } from './client.js';
import { goJSON, jsonObject } from './protocol.js';
import type { JSONObject, ObserveClientConfig, ObserveDecision, ObserveOperation } from './types.js';

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

  constructor(cause: unknown) {
    super('Protected tool outcome is unknown; reconcile before retrying', { cause });
    this.name = 'EnforceOutcomeUnknownError';
  }
}

/** Runs only explicitly allowed calls and withholds results that fail their check. */
export class EnforceClient {
  readonly #sidecar: ObserveClient;

  constructor(config: ObserveClientConfig) {
    this.#sidecar = new ObserveClient(config);
  }

  async enforce<Result extends JSONObject>(
    operation: ObserveOperation,
    argumentsValue: JSONObject,
    execute: (checkedArguments: JSONObject) => Result | Promise<Result>,
  ): Promise<{ result: Result; callDecision: ObserveDecision; resultDecision: ObserveDecision }> {
    if (typeof execute !== 'function') throw new Error('Protected tool function is required');
    let call;
    try { call = this.#sidecar.prepare(operation, argumentsValue); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    let callDecision: ObserveDecision;
    try { callDecision = await this.#sidecar.evaluate(call, 'tool_call', 'enforce'); }
    catch (cause) { throw new EnforceBlockedError('tool_call', false, null, cause); }
    if (!permitted(callDecision)) {
      throw new EnforceBlockedError('tool_call', false, callDecision);
    }

    // Only the protected application receives this callback and provider credentials.
    // The SDK cannot prove that a separate agent path cannot reach the same effect.
    let result: Result;
    try { result = await execute(call.arguments) as Result; }
    catch (cause) { throw new EnforceOutcomeUnknownError(cause); }
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
    return { result, callDecision, resultDecision };
  }
}

function permitted(decision: ObserveDecision): boolean {
  return decision.mode === 'enforce' && decision.enforced === false &&
    decision.coverage === 'evaluated' && decision.outcome === 'allow' &&
    decision.recordingStatus === 'retained' && decision.reportReplayed === false;
}
