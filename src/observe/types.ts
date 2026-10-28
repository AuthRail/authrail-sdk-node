import type { KeyObject } from 'node:crypto';

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

export type ExtractionProvenance = {
  sourceSha256: string;
  sourceBytes: number;
  sourceLocation: string;
  modelId: string;
  modelConfigSha256: string;
  promptVersion: string;
  extractedAt: string;
};

/** A protected lookup result pinned to a reviewed source version, not an authorization decision. */
export type FactResolution = {
  sourceVersionId: string;
  providerAccountId?: string;
  sourceIdentity?: string;
  accountBoundary?: string;
  lookup: string;
  lookupKey: string;
  authenticatedExecutor: boolean;
  status: 'ok' | 'unavailable' | 'uncertain' | 'untrusted';
  observedAt?: string;
  value?: JSONObject;
  extraction?: ExtractionProvenance;
};

/** Application-asserted session history; the sidecar checks it against its private ledger. */
export type TrajectorySnapshot = {
  sessionId: string;
  start?: boolean;
  complete: boolean;
  priorReadOperationVersionIds: string[];
  values?: JSONObject;
};

/** Small, application-supplied context for named human reviewers. Never include secrets. */
export type ReviewSummary = {
  title: string;
  fields: Array<{ label: string; value: string }>;
};

/** Identifies one reviewed action and the application's authenticated caller and target. */
export type ObserveOperation = {
  operationVersionId: string;
  actionKey: string;
  principalId: string;
  sessionId: string;
  resourceId?: string | null;
  principalSource: 'application_session' | 'service_identity';
  resourceSource: 'application_lookup' | 'not_applicable';
  factResolutions?: FactResolution[];
  trajectory?: TrajectorySnapshot;
  reviewSummary?: ReviewSummary;
  /** W3C correlation from protected application context, never authorization evidence. */
  traceparent?: string;
};

/** Advisory local decision; recording status is separate from evaluation coverage. */
export type ObserveDecision = {
  requestId: string;
  mode: 'observe' | 'enforce';
  enforced: false;
  coverage: 'evaluated' | 'uncovered' | 'unavailable';
  outcome: 'allow' | 'deny' | 'approval_required' | 'additional_context_required' | 'indeterminate';
  recordingStatus?: 'retained' | 'queued' | 'unavailable';
  reportReplayed?: boolean;
  actionId?: string;
  approvalRequestId?: string;
  certificateId?: string;
  [key: string]: unknown;
};

/** Independent call/result checks; errors never replace the protected function's result. */
export type Observation = {
  callDecision: ObserveDecision | null;
  callError: unknown;
  resultDecision: ObserveDecision | null;
  resultError: unknown;
};

/** Application-owned, version-pinned processing at a protected string boundary. */
export type GuardHandler = {
  id: string;
  version: string;
  kind: 'sanitize' | 'transform';
  /** Pure string processing; rejection, invalid output, or a four-second deadline blocks the boundary. */
  process: (value: string) => string | Promise<string>;
};

/** Signed processing assertion; it does not independently prove the registered handler's code. */
export type GuardEvidence = {
  phase: 'tool_call' | 'tool_result';
  bundleId: string;
  kind: 'sanitize' | 'transform';
  handlerId: string;
  handlerVersion: string;
  target: { root: 'arguments' | 'result'; path: string[] };
  inputSha256: string;
  outputSha256: string;
};

/** Local sidecar connection and application signing key; never supply a deployment credential. */
export type ObserveClientConfig = {
  sidecarUrl: string;
  adapterToken: string;
  organisationId: string;
  deploymentId: string;
  executorPrivateKey: string | KeyObject;
  fetch?: typeof globalThis.fetch;
  /** Enforce runs exact matching handlers; Observe never processes inputs or results. */
  guardHandlers?: GuardHandler[];
};

/** Explicit executor knowledge of an advisory attempt; exceptions alone do not prove failure. */
export type ObservedExecutionOutcome = {
  event: 'succeeded' | 'failed' | 'unknown' | 'reconciled_succeeded' | 'reconciled_failed';
  providerIdempotencyKey: string;
  providerReference: string | null;
};

export type ObservedExecutionRecording = { recordingStatus: 'retained' | 'queued';
  receiptId?: string; actionId?: string; state?: string; replayed?: boolean };
