import { lookupCustomerFact, lookupQuickBooksInvoiceBalance, lookupStripeInvoiceStatus,
  type CustomerRead } from '../facts.js';
import type { ObservedCall, Phase } from './protocol.js';
import { boundedJSON, jsonObject } from './protocol.js';
import type { FactResolution, JSONObject } from './types.js';

/** Trusted application identity supplied to a once-bound resource resolver, never agent arguments. */
export type DataResourceContext = Readonly<{ principalId: string; sessionId: string;
  resourceId: string | null; operationVersionId: string }>;
type BaseBinding = { sourceVersionId: string;
  resolveResource: (context: DataResourceContext) => string | Promise<string> };
/** Private reader credentials and resource binding for one exact reviewed source version. */
export type DataSourceBinding = BaseBinding & (
  | { kind: 'stripe'; providerAccountId: string; secretKey: string | (() => string | Promise<string>); connectedAccount?: boolean;
      fetch?: typeof globalThis.fetch }
  | { kind: 'quickbooks'; providerAccountId: string; accessToken: string | (() => string | Promise<string>); sandbox?: boolean;
      fetch?: typeof globalThis.fetch }
  | { kind: 'customer_api' | 'database' | 'mcp' | 'sdk'; sourceIdentity: string;
      accountBoundary: string; lookup: string; read: CustomerRead });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sourceName = /^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/;
const account = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function invalid(): never { throw new Error('Data source requirements or bindings are invalid'); }
const exact = (value: JSONObject, names: string[]) => Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));

export function registeredDataSources(input: DataSourceBinding[] | undefined): DataSourceBinding[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 32) invalid();
  const seen = new Set<string>();
  return input.map((binding) => {
    if (!binding || !uuid.test(binding.sourceVersionId) || seen.has(binding.sourceVersionId) ||
      typeof binding.resolveResource !== 'function') invalid();
    seen.add(binding.sourceVersionId);
    if (binding.kind === 'stripe') {
      if (!/^acct_[A-Za-z0-9]{8,80}$/.test(binding.providerAccountId) ||
        (typeof binding.secretKey !== 'function' && (typeof binding.secretKey !== 'string' || !binding.secretKey.trim() || /[\r\n]/.test(binding.secretKey))) ||
        binding.connectedAccount !== undefined && typeof binding.connectedAccount !== 'boolean') invalid();
    } else if (binding.kind === 'quickbooks') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(binding.providerAccountId) ||
        (typeof binding.accessToken !== 'function' && (typeof binding.accessToken !== 'string' || !binding.accessToken.trim() || /[\r\n]/.test(binding.accessToken))) ||
        binding.sandbox !== undefined && typeof binding.sandbox !== 'boolean') invalid();
    } else if (!['customer_api', 'database', 'mcp', 'sdk'].includes(binding.kind) ||
      !sourceName.test(binding.sourceIdentity) || !account.test(binding.accountBoundary) ||
      !sourceName.test(binding.lookup) || typeof binding.read !== 'function') invalid();
    return Object.freeze({ ...binding });
  });
}

type Source = { sourceVersionId: string; contract: JSONObject };
function parseSource(value: unknown): Source {
  if (!jsonObject(value) || !exact(value, ['sourceVersionId', 'contract']) ||
    typeof value.sourceVersionId !== 'string' || !uuid.test(value.sourceVersionId) || !jsonObject(value.contract)) invalid();
  const c = value.contract;
  const common = ['formatVersion', 'queryField', 'factKey', 'maxAgeSeconds', 'timeoutMs', 'failure'];
  if (!jsonObject(c.queryField) || !exact(c.queryField, ['root', 'path']) || c.queryField.root !== 'arguments' ||
    !Array.isArray(c.queryField.path) || !c.queryField.path.length || c.queryField.path.length > 12 ||
    c.queryField.path.some((part) => typeof part !== 'string' || !part || part.length > 80 || forbidden.has(part)) ||
    typeof c.factKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(c.factKey) ||
    !Number.isInteger(c.maxAgeSeconds) || Number(c.maxAgeSeconds) < 1 || Number(c.maxAgeSeconds) > 3600 ||
    !Number.isInteger(c.timeoutMs) || Number(c.timeoutMs) < 100 || Number(c.timeoutMs) > 10000 || c.failure !== 'unavailable') invalid();
  if (c.formatVersion === 1 || c.formatVersion === 3) {
    if (!exact(c, [...common, 'provider', 'lookup', 'providerAccountId', 'resultField']) ||
      typeof c.providerAccountId !== 'string' ||
      (c.formatVersion === 1 ? c.provider !== 'stripe' || c.lookup !== 'invoice.retrieve' || c.resultField !== 'status' || !/^acct_[A-Za-z0-9]{8,80}$/.test(c.providerAccountId)
        : c.provider !== 'quickbooks' || c.lookup !== 'invoice.read' || c.resultField !== 'Balance' || !/^[A-Za-z0-9_-]{1,80}$/.test(c.providerAccountId))) invalid();
  } else if (c.formatVersion === 4) {
    if (!exact(c, [...common, 'kind', 'sourceIdentity', 'lookup', 'accountBoundary', 'resultPath', 'valueType']) ||
      !['customer_api', 'database', 'mcp', 'sdk'].includes(String(c.kind)) || typeof c.sourceIdentity !== 'string' ||
      !sourceName.test(c.sourceIdentity) || typeof c.accountBoundary !== 'string' || !account.test(c.accountBoundary) ||
      typeof c.lookup !== 'string' || !sourceName.test(c.lookup) || !['string', 'number', 'boolean'].includes(String(c.valueType)) ||
      !Array.isArray(c.resultPath) || !c.resultPath.length || c.resultPath.length > 8 ||
      c.resultPath.some((part) => typeof part !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(part) || forbidden.has(part))) invalid();
  } else invalid();
  return { sourceVersionId: value.sourceVersionId, contract: c };
}

/** Fetch reviewed reads before signing each phase; never mutate a saved call or continuation. */
export async function resolveData(connection: { sidecarUrl: string; adapterToken: string; fetch: typeof globalThis.fetch },
  bindings: DataSourceBinding[] | undefined, call: ObservedCall, phase: Phase): Promise<{
    resolutions: FactResolution[] | undefined; bundleId?: string; sequence?: number }> {
  if (bindings === undefined) return { resolutions: call.factResolutions };
  const endpoint = new URL('/data-requirements', connection.sidecarUrl);
  endpoint.searchParams.set('operationVersionId', call.operationVersionId);
  endpoint.searchParams.set('phase', phase);
  const response = await connection.fetch(endpoint, { method: 'GET', redirect: 'manual',
    headers: { Authorization: `Bearer ${connection.adapterToken}`, ...(call.traceparent ? { traceparent: call.traceparent } : {}) },
    signal: AbortSignal.timeout(4000) });
  if (response.status !== 200) throw new Error('Data requirements are unavailable');
  const plan = await boundedJSON(response);
  if (!jsonObject(plan) || !exact(plan, ['formatVersion', 'operationVersionId', 'phase', 'bundleId', 'sequence', 'coverage', 'requirements']) ||
    plan.formatVersion !== 1 || plan.operationVersionId !== call.operationVersionId || plan.phase !== phase ||
    plan.coverage !== 'evaluated' || typeof plan.bundleId !== 'string' || !uuid.test(plan.bundleId) ||
    !Number.isSafeInteger(plan.sequence) || Number(plan.sequence) < 1 || !Array.isArray(plan.requirements) || plan.requirements.length > 32) invalid();
  const sources = plan.requirements.map(parseSource);
  const ids = new Set<string>();
  for (const source of sources) { if (ids.has(source.sourceVersionId)) invalid(); ids.add(source.sourceVersionId); }
  const manual = call.factResolutions ?? [];
  const manualIds = new Set<string>();
  for (const fact of manual) {
    if ((phase === 'tool_call' && ids.has(fact.sourceVersionId)) || manualIds.has(fact.sourceVersionId)) invalid();
    manualIds.add(fact.sourceVersionId);
  }
  const context: DataResourceContext = Object.freeze({ principalId: call.principalId,
    sessionId: call.sessionId, resourceId: call.resourceId ?? null, operationVersionId: call.operationVersionId });
  const deadline = AbortSignal.timeout(10000);
  const unavailable = ({ sourceVersionId, contract: c }: Source): FactResolution => {
    let value: unknown = call.arguments;
    for (const part of (c.queryField as JSONObject).path as string[]) value = jsonObject(value) && Object.hasOwn(value, part) ? value[part] : undefined;
    return { sourceVersionId, lookup: String(c.lookup), lookupKey: typeof value === 'string' ? value : '',
      authenticatedExecutor: true, status: 'unavailable', ...(c.formatVersion === 4
      ? { sourceIdentity: String(c.sourceIdentity), accountBoundary: String(c.accountBoundary) }
      : { providerAccountId: String(c.providerAccountId) }) };
  };
  const read = async ({ sourceVersionId, contract: c }: Source, sourceSignal: AbortSignal): Promise<FactResolution> => {
    const base: FactResolution = { sourceVersionId, lookup: String(c.lookup), lookupKey: '', authenticatedExecutor: true,
      status: 'unavailable', ...(c.formatVersion === 4 ? { sourceIdentity: String(c.sourceIdentity), accountBoundary: String(c.accountBoundary) }
        : { providerAccountId: String(c.providerAccountId) }) };
    let lookup: unknown = call.arguments;
    for (const part of (c.queryField as JSONObject).path as string[]) lookup = jsonObject(lookup) && Object.hasOwn(lookup, part) ? lookup[part] : undefined;
    if (typeof lookup !== 'string' || !lookup || Buffer.byteLength(lookup) > 256) return base;
    base.lookupKey = lookup;
    const binding = bindings.find((item) => item.sourceVersionId === sourceVersionId);
    if (!binding || sourceSignal.aborted) return base;
    const matches = c.formatVersion === 4 ? binding.kind === c.kind && 'sourceIdentity' in binding &&
      binding.sourceIdentity === c.sourceIdentity && binding.accountBoundary === c.accountBoundary && binding.lookup === c.lookup
      : binding.kind === c.provider && 'providerAccountId' in binding && binding.providerAccountId === c.providerAccountId;
    if (!matches) return { ...base, status: 'untrusted' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const trustedKey = await Promise.race([Promise.resolve().then(() => binding.resolveResource(context)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Resource unavailable')), Number(c.timeoutMs)); })]);
      if (typeof trustedKey !== 'string' || trustedKey !== lookup) return { ...base, status: 'untrusted' };
    } catch { return base; }
    finally { if (timer) clearTimeout(timer); }
    if (sourceSignal.aborted) return base;
    const boundedFetch: typeof globalThis.fetch = (input, init) => (('fetch' in binding ? binding.fetch : undefined) ?? globalThis.fetch)(input,
      { ...init, signal: AbortSignal.any([sourceSignal, ...(init?.signal ? [init.signal] : [])]) });
    const credential = async (value: string | (() => string | Promise<string>)): Promise<string> => {
      const result = typeof value === 'function' ? await value() : value;
      if (sourceSignal.aborted || typeof result !== 'string' || !result.trim() || /[\r\n]/.test(result)) throw new Error('Data credential unavailable');
      return result;
    };
    if (binding.kind === 'stripe') return lookupStripeInvoiceStatus({ ...binding, secretKey: await credential(binding.secretKey), timeoutMs: Number(c.timeoutMs), fetch: boundedFetch }, lookup);
    if (binding.kind === 'quickbooks') return lookupQuickBooksInvoiceBalance({ ...binding, accessToken: await credential(binding.accessToken), timeoutMs: Number(c.timeoutMs), fetch: boundedFetch }, lookup);
    return lookupCustomerFact({ ...binding, timeoutMs: Number(c.timeoutMs) }, lookup, (key, signal) => {
      if (sourceSignal.aborted) throw new Error('Data lookup deadline exceeded');
      return binding.read(key, AbortSignal.any([signal, sourceSignal]));
    });
  };
  const facts: FactResolution[] = sources.map(unavailable);
  let next = 0;
  const workers = Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (!deadline.aborted) {
      const index = next++;
      const source = sources[index];
      if (!source) return;
      const sourceSignal = AbortSignal.any([deadline, AbortSignal.timeout(Number(source.contract.timeoutMs))]);
      let sourceTimer: ReturnType<typeof setTimeout> | undefined;
      try { facts[index] = structuredClone(await Promise.race([read(source, sourceSignal), new Promise<FactResolution>((resolve) => {
        sourceTimer = setTimeout(() => resolve(unavailable(source)), Number(source.contract.timeoutMs));
      })])); } catch { facts[index] = unavailable(source); }
      finally { if (sourceTimer) clearTimeout(sourceTimer); }
    }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  try { completed = await Promise.race([workers.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 10000); })]); }
  finally { if (timer) clearTimeout(timer); }
  return { resolutions: structuredClone([...manual.filter((fact) => !ids.has(fact.sourceVersionId)), ...(completed ? facts : sources.map(unavailable))]), bundleId: plan.bundleId, sequence: Number(plan.sequence) };
}
