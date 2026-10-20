import { createHash, createPrivateKey, KeyObject, randomUUID, sign } from 'node:crypto';
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
  ): { result: Promise<Result>; observation: Promise<Observation> } {
    if (typeof execute !== 'function') throw new Error('Protected tool function is required');
    let call: ObservedCall | undefined;
    let callCheck: Promise<Checked>;
    try {
      const snapshot = freezeContext({
        operationVersionId: operation.operationVersionId,
        actionKey: operation.actionKey,
        principalId: operation.principalId,
        sessionId: operation.sessionId,
        principalSource: operation.principalSource,
        resourceSource: operation.resourceSource,
        ...(operation.resourceId !== undefined ? { resourceId: operation.resourceId } : {}),
        ...(operation.factResolutions !== undefined
          ? { factResolutions: operation.factResolutions }
          : {}),
        ...(operation.trajectory !== undefined ? { trajectory: operation.trajectory } : {}),
        arguments: argumentsValue,
      });
      if (
        !uuid.test(snapshot.operationVersionId) ||
        !reference.test(snapshot.actionKey) ||
        !reference.test(snapshot.principalId) ||
        !reference.test(snapshot.sessionId) ||
        (snapshot.resourceId !== undefined &&
          snapshot.resourceId !== null &&
          !reference.test(snapshot.resourceId)) ||
        !jsonObject(snapshot.arguments) ||
        Buffer.byteLength(goJSON(snapshot.arguments)) > 64 * 1024 ||
        !['application_session', 'service_identity'].includes(snapshot.principalSource) ||
        !['application_lookup', 'not_applicable'].includes(snapshot.resourceSource)
      ) {
        throw new Error('Observe call contract is invalid');
      }
      call = { ...snapshot, requestId: randomUUID() };
      callCheck = this.#evaluate(call, 'tool_call').then(
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
          const resultDecision = await this.#evaluate(call, 'tool_result', value);
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
    return { result, observation };
  }

  /** Signs the exact canonical input and authenticated application claims for this phase. */
  async #evaluate(call: ObservedCall, phase: Phase, result?: unknown): Promise<ObserveDecision> {
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
      attribution,
      identityProof: { issuedAt, expiresAt, signature },
    };
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Idempotency-Key': call.actionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
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
      decision.mode !== 'observe' ||
      !('enforced' in decision) ||
      !('coverage' in decision) ||
      !('outcome' in decision) ||
      decision.enforced !== false ||
      typeof decision.coverage !== 'string' ||
      typeof decision.outcome !== 'string' ||
      !coverage.has(decision.coverage) ||
      !outcomes.has(decision.outcome)
    ) {
      throw new Error('Sidecar decision contract is invalid');
    }
    return decision as ObserveDecision;
  }
}
