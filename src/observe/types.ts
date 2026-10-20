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
};

/** Advisory local decision; recording status is separate from evaluation coverage. */
export type ObserveDecision = {
  requestId: string;
  mode: 'observe';
  enforced: false;
  coverage: 'evaluated' | 'uncovered' | 'unavailable';
  outcome: 'allow' | 'deny' | 'approval_required' | 'additional_context_required' | 'indeterminate';
  recordingStatus?: 'retained' | 'queued' | 'unavailable';
  actionId?: string;
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

/** Local sidecar connection and application signing key; never supply a deployment credential. */
export type ObserveClientConfig = {
  sidecarUrl: string;
  adapterToken: string;
  organisationId: string;
  deploymentId: string;
  executorPrivateKey: string | KeyObject;
  fetch?: typeof globalThis.fetch;
};
