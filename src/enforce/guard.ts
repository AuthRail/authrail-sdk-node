import { createHash } from 'node:crypto';
import type { GuardEvidence, GuardHandler, JSONObject } from '../observe/types.js';
import type { Phase } from '../observe/protocol.js';
import { freezeContext, goJSON, jsonObject } from '../observe/protocol.js';

type Requirement = {
  railVersionId: string;
  ruleId: string;
  kind: 'sanitize' | 'transform' | 'isolate';
  handlerId: string;
  handlerVersion: string;
  target: { root: 'arguments' | 'result'; path: string[] };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const segment = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const digest = /^[0-9a-f]{64}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function fail(): never { throw new Error('Guard processing requirements cannot be fulfilled'); }
const sameKeys = (value: JSONObject, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const handlerKey = (id: string, version: string, kind: string) => `${id}:${version}:${kind}`;
const requirementKey = (value: Requirement) =>
  `${handlerKey(value.handlerId, value.handlerVersion, value.kind)}:${goJSON(value.target)}`;

const credentialHandlerId = 'authrail_redact_credentials_v1';
const credentialHandlerVersion = 'cea4d8ac57cc39a33a9584742b56e412ff889026cb6b69b086bccbe4cc25d833';
const privateKeyMarkers = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY']
  .map((label) => `-----BEGIN ${label}-----`);
const credentialToken = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|(?:AKIA|ASIA)[A-Z0-9]{16})(?:$|[^A-Za-z0-9_])/;

// Version one removes the whole reviewed field, never just a possibly incomplete match.
function redactCredentials(value: string): string {
  return privateKeyMarkers.some((marker) => value.includes(marker)) || credentialToken.test(value)
    ? '[REDACTED]' : value;
}

const emailCandidates = /[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;
const cardCandidates = /[0-9](?:[0-9 -]*[0-9])?/g;

function emailAddressV1(value: string): boolean {
  for (const match of value.matchAll(emailCandidates)) {
    const index = match.index;
    if (/[A-Za-z0-9._%+@-]/.test(value[index - 1] ?? '') ||
      /[A-Za-z0-9_@-]/.test(value[index + match[0].length] ?? '')) continue;
    const [local, domain] = match[0].split('@') as [string, string];
    const last = domain.slice(domain.lastIndexOf('.') + 1);
    if (match[0].length <= 254 && !local.includes('..') && !local.endsWith('.') &&
      /^[A-Za-z]{2,63}$/.test(last)) return true;
  }
  return false;
}

function paymentCardV1(value: string): boolean {
  for (const match of value.matchAll(cardCandidates)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || /^([0-9])\1+$/.test(digits)) continue;
    let sum = 0;
    for (let index = digits.length - 1, double = false; index >= 0; index--, double = !double) {
      let digit = Number(digits[index]);
      if (double) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

const localBuiltins: GuardHandler[] = [
  { id: 'authrail_redact_email_v1', version: '9773bce1f804773de4e773f4fedbc3f8a15785d26e70e49ad7b600eb631ea49d',
    kind: 'sanitize', process: (value) => emailAddressV1(value) ? '[REDACTED]' : value },
  { id: 'authrail_redact_payment_card_v1', version: '01c828b26465d66ad89cb6a350c82d9afa1d8673ee8e167acfc33bde27c1535b',
    kind: 'sanitize', process: (value) => paymentCardV1(value) ? '[REDACTED]' : value },
  { id: 'authrail_withhold_field_v1', version: '3ebd6aaea66cbd30459938a624b0f74d6bea612e28d6638273a67145b2fe5555',
    kind: 'sanitize', process: () => '[WITHHELD]' },
];
const reservedHandlerIds = new Set([credentialHandlerId, ...localBuiltins.map((handler) => handler.id)]);

export function registeredHandlers(input: GuardHandler[] | undefined): Map<string, GuardHandler> {
  const builtin: GuardHandler = { id: credentialHandlerId, version: credentialHandlerVersion,
    kind: 'sanitize', process: redactCredentials };
  const handlers = new Map<string, GuardHandler>([
    [handlerKey(builtin.id, builtin.version, builtin.kind), builtin],
    ...localBuiltins.map((handler): [string, GuardHandler] => [handlerKey(handler.id, handler.version, handler.kind), handler]),
  ]);
  if (input === undefined) return handlers;
  if (!Array.isArray(input) || input.length > 64) fail();
  for (const handler of input) {
    if (!handler || reservedHandlerIds.has(handler.id) || !identifier.test(handler.id) || !digest.test(handler.version) ||
      !['sanitize', 'transform'].includes(handler.kind) || typeof handler.process !== 'function') fail();
    const key = handlerKey(handler.id, handler.version, handler.kind);
    if (handlers.has(key)) fail();
    handlers.set(key, { ...handler });
  }
  return handlers;
}

function parsePlan(value: unknown, operationVersionId: string, phase: Phase) {
  if (!jsonObject(value) || !sameKeys(value, ['formatVersion', 'operationVersionId', 'phase',
    'bundleId', 'sequence', 'coverage', 'requirements']) || value.formatVersion !== 1 ||
    value.operationVersionId !== operationVersionId || value.phase !== phase ||
    typeof value.bundleId !== 'string' || !uuid.test(value.bundleId) ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
    value.coverage !== 'evaluated' || !Array.isArray(value.requirements) ||
    value.requirements.length > 64) fail();
  const requirements: Requirement[] = [];
  const seen = new Set<string>();
  for (const raw of value.requirements) {
    if (!jsonObject(raw) || !sameKeys(raw, ['railVersionId', 'ruleId', 'kind', 'handlerId',
      'handlerVersion', 'target']) || typeof raw.railVersionId !== 'string' ||
      !uuid.test(raw.railVersionId) || typeof raw.ruleId !== 'string' || !identifier.test(raw.ruleId) ||
      !['sanitize', 'transform', 'isolate'].includes(String(raw.kind)) ||
      typeof raw.handlerId !== 'string' || !identifier.test(raw.handlerId) ||
      typeof raw.handlerVersion !== 'string' || !digest.test(raw.handlerVersion) ||
      !jsonObject(raw.target) || !sameKeys(raw.target, ['root', 'path']) ||
      raw.target.root !== (phase === 'tool_call' ? 'arguments' : 'result') ||
      !Array.isArray(raw.target.path) || raw.target.path.length < 1 || raw.target.path.length > 8 ||
      raw.target.path.some((part) => typeof part !== 'string' || !segment.test(part) ||
        forbidden.has(part))) fail();
    const requirement = raw as unknown as Requirement;
    const key = requirementKey(requirement);
    if (seen.has(key)) continue;
    for (const existing of requirements) {
      const left = existing.target.path, right = requirement.target.path;
      if (left.slice(0, Math.min(left.length, right.length)).every((part, i) => part === right[i])) fail();
    }
    seen.add(key);
    requirements.push(requirement);
  }
  return { bundleId: value.bundleId, sequence: Number(value.sequence), requirements };
}

/** Process a copy; only exact reviewed string targets can change before final evaluation. */
export async function processGuard(value: unknown, operationVersionId: string, phase: Phase,
  input: JSONObject, handlers: Map<string, GuardHandler>) {
  const plan = parsePlan(value, operationVersionId, phase);
  const output = freezeContext(input);
  const evidence: GuardEvidence[] = [];
  for (const requirement of plan.requirements) {
    if (requirement.kind === 'isolate') fail();
    const handler = handlers.get(handlerKey(requirement.handlerId, requirement.handlerVersion, requirement.kind));
    if (!handler) fail();
    let target: JSONObject = output;
    const path = requirement.target.path;
    for (const part of path.slice(0, -1)) {
      const child = target[part];
      if (!Object.hasOwn(target, part) || !jsonObject(child)) fail();
      target = child;
    }
    const leaf = path[path.length - 1]!;
    const before = target[leaf];
    if (!Object.hasOwn(target, leaf) || typeof before !== 'string') fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after: unknown;
    try {
      after = await Promise.race([Promise.resolve().then(() => handler.process(before)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Guard handler timed out')), 4000);
        })]);
    } finally { if (timer) clearTimeout(timer); }
    if (typeof after !== 'string') fail();
    target[leaf] = after;
    if (Buffer.byteLength(goJSON(output)) > 64 * 1024) fail();
    evidence.push({ phase, bundleId: plan.bundleId, kind: requirement.kind,
      handlerId: requirement.handlerId, handlerVersion: requirement.handlerVersion,
      target: freezeContext(requirement.target),
      inputSha256: createHash('sha256').update(goJSON(before)).digest('hex'),
      outputSha256: createHash('sha256').update(goJSON(after)).digest('hex') });
  }
  return { output, evidence, bundleId: plan.bundleId, sequence: plan.sequence };
}
