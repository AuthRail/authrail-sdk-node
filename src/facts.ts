import { createHash } from 'node:crypto';
import { readBoundedText } from './discovery.js';
import { goJSON, jsonObject } from './observe/protocol.js';
import type { FactResolution, JSONObject, JSONValue } from './observe/types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sourceName = /^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/;
const account = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const record = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const version = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,159}$/;
const location = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const field = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const digest = /^[0-9a-f]{64}$/;
const stripeAccount = /^acct_[A-Za-z0-9]{8,80}$/;
const stripeInvoice = /^in_[A-Za-z0-9]{4,100}$/;
const quickBooksRealm = /^[A-Za-z0-9_-]{1,80}$/;
const quickBooksInvoice = /^[A-Za-z0-9_-]{1,80}$/;

export type CustomerSource = { sourceVersionId: string; sourceIdentity: string;
  accountBoundary: string; lookup: string; timeoutMs: number };

/** Reads a reviewed Stripe account and invoice; failures remain unavailable context. */
export async function lookupStripeInvoiceStatus(source: {
  sourceVersionId: string; providerAccountId: string; connectedAccount?: boolean;
  timeoutMs: number; secretKey: string; fetch?: typeof globalThis.fetch;
}, invoiceId: string): Promise<FactResolution> {
  if (!uuid.test(source.sourceVersionId) || !stripeAccount.test(source.providerAccountId) ||
    !stripeInvoice.test(invoiceId) || !validTimeout(source.timeoutMs) ||
    !source.secretKey?.trim() || /[\r\n]/.test(source.secretKey)) {
    throw new Error('Stripe fact lookup configuration is invalid');
  }
  const resolution: FactResolution = { sourceVersionId: source.sourceVersionId,
    providerAccountId: source.providerAccountId, lookup: 'invoice.retrieve',
    lookupKey: invoiceId, authenticatedExecutor: true, status: 'unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs);
  const basic = `Basic ${Buffer.from(`${source.secretKey}:`).toString('base64')}`;
  const request = async (path: string, connected: boolean): Promise<unknown> => {
    const response = await (source.fetch ?? fetch)(`https://api.stripe.com/v1/${path}`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: basic, ...(connected ? { 'Stripe-Account': source.providerAccountId } : {}) },
    });
    if (response.status !== 200) throw new Error('Stripe lookup unavailable');
    const body = await readBoundedText(response, 64 * 1024);
    return JSON.parse(body) as unknown;
  };
  try {
    const accountValue = await request('account', !!source.connectedAccount);
    if (!accountValue || typeof accountValue !== 'object' || Array.isArray(accountValue) ||
      !('object' in accountValue) || accountValue.object !== 'account' ||
      !('id' in accountValue) || accountValue.id !== source.providerAccountId) {
      return { ...resolution, status: 'untrusted' };
    }
    const invoiceValue = await request(`invoices/${invoiceId}`, !!source.connectedAccount);
    if (controller.signal.aborted) return resolution;
    if (!invoiceValue || typeof invoiceValue !== 'object' || Array.isArray(invoiceValue) ||
      !('object' in invoiceValue) || invoiceValue.object !== 'invoice' ||
      !('id' in invoiceValue) || invoiceValue.id !== invoiceId ||
      !('status' in invoiceValue) ||
      !['draft', 'open', 'paid', 'uncollectible', 'void'].includes(String(invoiceValue.status))) {
      return { ...resolution, status: 'untrusted' };
    }
    return { ...resolution, status: 'ok', observedAt: new Date().toISOString(),
      value: { status: invoiceValue.status as string } };
  } catch { return resolution; }
  finally { clearTimeout(timer); }
}

export type QuickBooksInvoiceSource = {
  sourceVersionId: string; providerAccountId: string; sandbox?: boolean;
  timeoutMs: number; accessToken: string; fetch?: typeof globalThis.fetch;
};

/** Reads one invoice in the reviewed QuickBooks realm with a protected OAuth token. */
export async function lookupQuickBooksInvoiceBalance(source: QuickBooksInvoiceSource,
  invoiceId: string): Promise<FactResolution> {
  if (!uuid.test(source.sourceVersionId) || !quickBooksRealm.test(source.providerAccountId) ||
    !quickBooksInvoice.test(invoiceId) || !validTimeout(source.timeoutMs) ||
    (source.sandbox !== undefined && typeof source.sandbox !== 'boolean') ||
    !source.accessToken?.trim() || /[\r\n]/.test(source.accessToken)) {
    throw new Error('QuickBooks fact lookup configuration is invalid');
  }
  const resolution: FactResolution = { sourceVersionId: source.sourceVersionId,
    providerAccountId: source.providerAccountId, lookup: 'invoice.read',
    lookupKey: invoiceId, authenticatedExecutor: true, status: 'unavailable' };
  const host = source.sandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
  const url = `https://${host}/v3/company/${source.providerAccountId}/invoice/${invoiceId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs);
  try {
    const response = await (source.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${source.accessToken}`, Accept: 'application/json' } });
    if (response.status !== 200) return resolution;
    const body = await readBoundedText(response, 64 * 1024);
    if (controller.signal.aborted) return resolution;
    let value: unknown;
    try { value = JSON.parse(body) as unknown; }
    catch { return { ...resolution, status: 'untrusted' }; }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('Invoice' in value) || !value.Invoice || typeof value.Invoice !== 'object' ||
      Array.isArray(value.Invoice) || !('Id' in value.Invoice) ||
      value.Invoice.Id !== invoiceId || !('Balance' in value.Invoice) ||
      typeof value.Invoice.Balance !== 'number' ||
      !Number.isFinite(value.Invoice.Balance) || value.Invoice.Balance < 0) {
      return { ...resolution, status: 'untrusted' };
    }
    return { ...resolution, status: 'ok', observedAt: new Date().toISOString(),
      value: { Invoice: { Balance: value.Invoice.Balance } } };
  } catch { return resolution; }
  finally { clearTimeout(timer); }
}
export type CustomerReadResult = { sourceIdentity: string; accountBoundary: string;
  lookup: string; lookupKey: string; observedAt: string; value: JSONObject };
export type CustomerRead = (lookupKey: string, signal: AbortSignal) => Promise<CustomerReadResult>;

function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 10_000;
}

function boundedJSON(value: unknown, maxBytes: number): value is JSONObject {
  try { return jsonObject(value) && Buffer.byteLength(goJSON(value)) <= maxBytes; }
  catch { return false; }
}

function validObservedAt(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis <= Date.now() + 5000;
}

/** Reads one reviewed customer source with a credential-owning application callback. */
export async function lookupCustomerFact(source: CustomerSource, lookupKey: string,
  read: CustomerRead): Promise<FactResolution> {
  if (!uuid.test(source.sourceVersionId) || !sourceName.test(source.sourceIdentity) ||
    !account.test(source.accountBoundary) || !sourceName.test(source.lookup) ||
    !lookupKey || Buffer.byteLength(lookupKey) > 256 || !validTimeout(source.timeoutMs) ||
    typeof read !== 'function') throw new Error('Customer fact lookup configuration is invalid');
  const resolution: FactResolution = { sourceVersionId: source.sourceVersionId,
    sourceIdentity: source.sourceIdentity, accountBoundary: source.accountBoundary,
    lookup: source.lookup, lookupKey, authenticatedExecutor: true, status: 'unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs);
  try {
    const result = await read(lookupKey, controller.signal);
    if (controller.signal.aborted) return resolution;
    if (result.sourceIdentity !== source.sourceIdentity ||
      result.accountBoundary !== source.accountBoundary || result.lookup !== source.lookup ||
      result.lookupKey !== lookupKey || !validObservedAt(result.observedAt) ||
      !boundedJSON(result.value, 16 * 1024)) return { ...resolution, status: 'untrusted' };
    return { ...resolution, status: 'ok', observedAt: new Date(result.observedAt).toISOString(),
      value: result.value };
  } catch { return resolution; }
  finally { clearTimeout(timer); }
}

/** Builds a fixed HTTPS GET reader; bearer credentials stay in the protected application. */
export function newCustomerAPIReader(config: { endpoint: string; bearerToken: string;
  sourceIdentity: string; accountBoundary: string; lookup: string;
  fetch?: typeof globalThis.fetch }): CustomerRead {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); }
  catch { throw new Error('Customer API reader configuration is invalid'); }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username ||
    endpoint.password || endpoint.search || endpoint.hash ||
    !sourceName.test(config.sourceIdentity) || !sourceName.test(config.lookup) ||
    !account.test(config.accountBoundary) || !config.bearerToken ||
    /[\r\n]/.test(config.bearerToken)) {
    throw new Error('Customer API reader configuration is invalid');
  }
  return async (lookupKey, signal) => {
    if (!record.test(lookupKey) || lookupKey === '.' || lookupKey === '..')
      throw new Error('Customer record key is invalid');
    const url = new URL(endpoint);
    url.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${lookupKey}`;
    const response = await (config.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${config.bearerToken}`, Accept: 'application/json' }, signal });
    if (response.status !== 200) throw new Error('Customer API lookup unavailable');
    const body = await readBoundedText(response, 32 * 1024);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error('Customer API lookup unavailable'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'accountId,data,observedAt,recordId') {
      throw new Error('Customer API lookup unavailable');
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.accountId !== 'string' || typeof value.recordId !== 'string' ||
      typeof value.observedAt !== 'string' || !jsonObject(value.data)) {
      throw new Error('Customer API lookup unavailable');
    }
    return { sourceIdentity: config.sourceIdentity, accountBoundary: value.accountId,
      lookup: config.lookup, lookupKey: value.recordId, observedAt: value.observedAt,
      value: value.data as JSONObject };
  };
}

export type ExtractionSource = CustomerSource & { resultPath: string[];
  valueType: 'string' | 'number' | 'boolean'; modelId: string;
  modelConfigSha256: string; promptVersion: string;
  maxInputBytes: number; maxOutputBytes: number };
export type ExtractionResult = { value: JSONValue; uncertain: boolean;
  modelId: string; modelConfigSha256: string; promptVersion: string };
export type Extractor = (document: Uint8Array, signal: AbortSignal) => Promise<ExtractionResult>;

/** Validates one bounded model reading as context, never as a policy decision. */
export async function extractContextFact(source: ExtractionSource, lookupKey: string,
  sourceLocation: string, observedAt: string, document: Uint8Array,
  extractor: Extractor): Promise<FactResolution> {
  if (!uuid.test(source.sourceVersionId) || !sourceName.test(source.sourceIdentity) ||
    !account.test(source.accountBoundary) || !sourceName.test(source.lookup) ||
    !lookupKey || Buffer.byteLength(lookupKey) > 256 || !location.test(sourceLocation) ||
    !version.test(source.modelId) || !digest.test(source.modelConfigSha256) ||
    !version.test(source.promptVersion) || !validTimeout(source.timeoutMs) ||
    !Array.isArray(source.resultPath) || source.resultPath.length < 1 ||
    source.resultPath.length > 8 || !source.resultPath.every((part) => field.test(part)) ||
    !['string', 'number', 'boolean'].includes(source.valueType) ||
    !Number.isInteger(source.maxInputBytes) || source.maxInputBytes < 1 ||
    source.maxInputBytes > 65536 || !Number.isInteger(source.maxOutputBytes) ||
    source.maxOutputBytes < 1 || source.maxOutputBytes > 4096 ||
    !validObservedAt(observedAt) || typeof extractor !== 'function') {
    throw new Error('Extraction source configuration is invalid');
  }
  const resolution: FactResolution = { sourceVersionId: source.sourceVersionId,
    sourceIdentity: source.sourceIdentity, accountBoundary: source.accountBoundary,
    lookup: source.lookup, lookupKey, authenticatedExecutor: true, status: 'unavailable' };
  if (!(document instanceof Uint8Array) || !document.byteLength ||
    document.byteLength > source.maxInputBytes) return resolution;
  const copy = Uint8Array.from(document);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs);
  let result: ExtractionResult;
  try { result = await extractor(copy, controller.signal); }
  catch { return resolution; }
  finally { clearTimeout(timer); }
  if (controller.signal.aborted) return resolution;
  if (result.modelId !== source.modelId ||
    result.modelConfigSha256 !== source.modelConfigSha256 ||
    result.promptVersion !== source.promptVersion) return { ...resolution, status: 'untrusted' };
  const extraction = { sourceSha256: createHash('sha256').update(copy).digest('hex'),
    sourceBytes: copy.byteLength, sourceLocation, modelId: result.modelId,
    modelConfigSha256: result.modelConfigSha256, promptVersion: result.promptVersion,
    extractedAt: new Date().toISOString() };
  const provenance = { ...resolution, observedAt: new Date(observedAt).toISOString(), extraction };
  if (result.uncertain) return { ...provenance, status: 'uncertain' };
  if (typeof result.value !== source.valueType ||
    (typeof result.value === 'number' && !Number.isFinite(result.value))) {
    return { ...resolution, status: 'untrusted' };
  }
  let value: JSONObject = {};
  for (let i = source.resultPath.length - 1; i >= 0; i--) {
    const segment = source.resultPath[i];
    if (!segment) return { ...resolution, status: 'untrusted' };
    value = { [segment]: i === source.resultPath.length - 1 ? result.value : value };
  }
  if (!boundedJSON(value, source.maxOutputBytes)) return { ...resolution, status: 'untrusted' };
  return { ...provenance, status: 'ok', value };
}
