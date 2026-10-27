import type { FactResolution, GuardEvidence, JSONObject, ObserveOperation, TrajectorySnapshot } from './types.js';

export type Phase = 'tool_call' | 'tool_result';
export type ObservedCall = ObserveOperation & { arguments: JSONObject; requestId: string; guardEvidence?: GuardEvidence[] };
type Field = [string, string];

function jsonString(value: string | number | boolean | null): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Matches Go's JSON key order for the cross-language signed input digest. */
export function goJSON(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return jsonString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(goJSON).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => `${jsonString(key)}:${goJSON(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Observe context must contain only JSON values');
}

export function fields(entries: Field[]): string {
  return `{${entries.map(([key, value]) => `${jsonString(key)}:${value}`).join(',')}}`;
}

function optional<T>(
  entries: Field[],
  key: string,
  value: T | null | undefined,
  encode: (value: T) => string = goJSON,
) {
  if (
    value !== undefined &&
    value !== null &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0) &&
    (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)
  ) {
    entries.push([key, encode(value)]);
  }
}

export function encodeAttribution(
  value: Pick<
    ObserveOperation,
    'principalId' | 'sessionId' | 'resourceId' | 'principalSource' | 'resourceSource'
  >,
): string {
  const entries: Field[] = [
    ['principalId', goJSON(value.principalId)],
    ['sessionId', goJSON(value.sessionId)],
    ['resourceId', goJSON(value.resourceId ?? null)],
  ];
  optional(entries, 'principalSource', value.principalSource);
  optional(entries, 'resourceSource', value.resourceSource);
  return fields(entries);
}

function encodeExtraction(value: NonNullable<FactResolution['extraction']>): string {
  return fields([
    ['sourceSha256', goJSON(value.sourceSha256)],
    ['sourceBytes', goJSON(value.sourceBytes)],
    ['sourceLocation', goJSON(value.sourceLocation)],
    ['modelId', goJSON(value.modelId)],
    ['modelConfigSha256', goJSON(value.modelConfigSha256)],
    ['promptVersion', goJSON(value.promptVersion)],
    ['extractedAt', goJSON(value.extractedAt)],
  ]);
}

function encodeFact(value: FactResolution): string {
  const entries: Field[] = [['sourceVersionId', goJSON(value.sourceVersionId)]];
  optional(entries, 'providerAccountId', value.providerAccountId);
  optional(entries, 'sourceIdentity', value.sourceIdentity);
  optional(entries, 'accountBoundary', value.accountBoundary);
  entries.push(
    ['lookup', goJSON(value.lookup)],
    ['lookupKey', goJSON(value.lookupKey)],
    ['authenticatedExecutor', goJSON(value.authenticatedExecutor)],
    ['status', goJSON(value.status)],
  );
  optional(entries, 'observedAt', value.observedAt);
  optional(entries, 'value', value.value);
  optional(entries, 'extraction', value.extraction, encodeExtraction);
  return fields(entries);
}

function encodeTrajectory(value: TrajectorySnapshot): string {
  const entries: Field[] = [['sessionId', goJSON(value.sessionId)]];
  if (value.start) entries.push(['start', 'true']);
  entries.push(
    ['complete', goJSON(value.complete)],
    ['priorReadOperationVersionIds', goJSON(value.priorReadOperationVersionIds)],
  );
  optional(entries, 'values', value.values);
  return fields(entries);
}

export function encodeInput(call: ObservedCall, phase: Phase, result?: unknown): string {
  const entries: Field[] = [['arguments', goJSON(call.arguments)]];
  if (phase === 'tool_result') entries.push(['result', goJSON(result)]);
  optional(
    entries,
    'factResolutions',
    call.factResolutions,
    (items) => `[${items.map(encodeFact).join(',')}]`,
  );
  optional(entries, 'trajectory', call.trajectory, encodeTrajectory);
  optional(entries, 'guardEvidence', call.guardEvidence);
  return fields(entries);
}

export function jsonObject(value: unknown): value is JSONObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Copies bounded context before asynchronous checks so caller mutation cannot change the proof. */
export function freezeContext<T>(value: T): T {
  const encoded = goJSON(value);
  if (Buffer.byteLength(encoded) > 128 * 1024) throw new Error('Observe context is too large');
  return JSON.parse(encoded) as T;
}

/** Rejects oversized sidecar responses before parsing untrusted JSON. */
export async function boundedJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Sidecar response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128 * 1024) {
      await reader.cancel();
      throw new Error('Sidecar response is too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
