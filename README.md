<p align="center">
  <img src="assets/authrail-logo.png" alt="AuthRail" width="120" />
</p>

# AuthRail Node SDK

The AuthRail Node SDK is a TypeScript-first adapter for checking AI-requested
actions in a protected Node.js application. Add its checks where your
application handles an action. Your application still owns the tool and its
credentials. The SDK sends the action and its result to a sidecar running
beside the application, then returns what your active Rails would decide.

**Observe checks are advisory.** A deny decision,
missing sidecar, or recording failure does not stop your function. Use the
returned observation to monitor coverage; do not treat it as enforcement or
proof that a business action completed.

## What you need

- Node.js 20 or newer, with the SDK in your protected application—not in an
  agent-accessible tool or browser bundle.
- A reviewed AuthRail Operation Version and an Observe deployment for the AI
  system whose action you are checking.
- An AuthRail sidecar on the same host, configured with that deployment's
  credential, an adapter token, and a durable private state path.
- An Ed25519 application key pair. Register its public key on the deployment
  page and give it to the sidecar. Keep its private key in the protected
  application.

Create the key pair with:

```bash
openssl genpkey -algorithm Ed25519 -out executor-private.pem
openssl pkey -in executor-private.pem -pubout -out executor-public.pem
```

The adapter token is **not** the sidecar's AuthRail deployment credential.
Both must stay out of the agent. Follow the
[sidecar setup guide](https://github.com/AuthRail/authrail-sidecar#readme) for
its deployment credential, durable state, and local health endpoint. Install
this SDK in the protected Node application; it does not replace the sidecar.
For a Go application, use the
[Go SDK](https://github.com/AuthRail/authrail-sdk-go) with the same sidecar.

## Install

```bash
npm install @authrail/sdk-node
```

The package exports compiled JavaScript and TypeScript declarations from
`dist/`. This repository uses `npm ci` and `npm run build` for local development.

## Discover and supply reviewed facts

`discover` uses a tenant-issued, short-lived setup key to resolve an AI
Inventory item and deployment. It does not issue a deployment credential or
authorize an action. Keep the setup key in the protected application.

`lookupStripeInvoiceStatus` reads the reviewed Stripe account and invoice;
for Stripe Connect it verifies the connected account with `Stripe-Account` on
both reads.
`lookupQuickBooksInvoiceBalance` reads one invoice from the reviewed QuickBooks
Online realm using an application-owned OAuth access token. Set `sandbox: true`
only for an Intuit test company; otherwise the fixed production endpoint is
used. The result has `Invoice.Balance`, matching the reviewed Data Rail. A
different invoice ID or invalid balance is `untrusted`; provider failure or a
redirect is `unavailable`. The caller supplies the exact realm, invoice ID,
timeout, and Context Source Version from the reviewed contract, never from the
agent. The caller owns token acquisition and refresh; the SDK does not store a
refresh token or create a QuickBooks connection. `Balance` is in the invoice's
currency; this source contract does not pin a currency, so a numeric threshold
must not be presented as currency-qualified without another reviewed source.

The protected application owns QuickBooks consent and the OAuth callback. Bind
the returned realm ID to the reviewed account before storing tokens in its
own encrypted, access-controlled credential store. Refresh before a read when
needed, serialize refresh per realm, and persist the newest access and refresh
tokens together before using them; an expired, revoked, or mismatched grant
must yield unavailable context and require reconnection. Do not pass tokens,
OAuth codes, or provider response bodies to the agent, sidecar, or AuthRail.
Stripe keys likewise stay in that store and must be scoped to the reviewed
account. The SDK accepts an application-supplied access token for one bounded
read; it does not perform consent, persist tokens, or retry an effect.

`lookupCustomerFact` accepts an application-owned read callback, and
`newCustomerAPIReader` supplies a fixed HTTPS GET callback. Each returns an
`ok`, `unavailable`, or `untrusted` fact resolution bound to the reviewed
source, account, and lookup. Pass it as `factResolutions` on the Operation.
Provider or customer API credentials remain in the protected application,
outside the agent and sidecar. Configure all helpers from the exact reviewed
Context Source Version, never from an agent-supplied URL or account.

`extractContextFact` accepts bounded document bytes and a callback for the
configured model. It checks the reviewed model, settings fingerprint,
instructions version, one typed result, size, and uncertainty, then returns
a fact resolution. The protected executor signs it as part of the Operation
sent to the sidecar. The model supplies context, not a Rail decision.
AuthRail receives bounded provenance and status, not the raw document or
fact value. The callback must honor its abort signal; the SDK cannot forcibly
stop an arbitrary callback that ignores cancellation.

For the reviewed OpenAI Decisions source, use `gpt-6-luna` and one predicate,
choice, or score question. Pin `openAIDecisionsConfigSha256(question)` as the
Context Source Version's settings fingerprint before publishing it. The
protected application uses that same reviewed question and supplies its own
OpenAI key; the key and raw document never go to the agent, sidecar, or
AuthRail server. For example:

```ts
const question = { type: "predicate", instructions: "Does this message contain a payment card number?",
  minConfidence: 0.8 } as const;
if (openAIDecisionsConfigSha256(question) !== reviewedSource.modelConfigSha256) {
  throw new Error("The reviewed contextual question has changed");
}
const extractor = newOpenAIDecisionsExtractor({ source: reviewedSource, question,
  apiKey: openAiKeyHeldByApplication });
const fact = await extractContextFact(reviewedSource, message.id, message.sourceLocation,
  message.observedAt, message.bytes, extractor);
operation.factResolutions = [fact];
```

The Decisions API receives only the bounded document text from this protected
application. A refusal or a predicate probability between the reviewed true
and false thresholds produces `uncertain`; a sufficiently low probability
produces `false`. Choice and score answers below the confidence threshold are
also `uncertain`. A timeout or provider failure produces `unavailable`.
Neither status supplies a trusted fact. A sufficiently confident answer is
still contextual input to the published Rail, never a final allow decision or
independent proof that the model understood the document.

```ts
const fact = await lookupCustomerFact(reviewedSource, invoice.id,
  async (key, signal) => privateInvoiceLookup(key, { signal }));
const checkedOperation = { ...operation, factResolutions: [fact] };
```

Use `traceparent` on an Operation only when it comes from the protected
application's trace context. The sidecar forwards it for correlation; it
does not prove caller identity, permission, or execution.

## Observe your first action

Create one client in the protected application. Load the private key from your
secret store or a private file; the example uses a file for clarity.

```ts
import { readFileSync } from "node:fs";
import { ObserveClient } from "@authrail/sdk-node";

const authrail = new ObserveClient({
  sidecarUrl: "http://127.0.0.1:7078",
  adapterToken: process.env.AUTHRAIL_ADAPTER_TOKEN!,
  organisationId: organisation.id,
  deploymentId: deployment.id,
  executorPrivateKey: readFileSync(process.env.AUTHRAIL_EXECUTOR_PRIVATE_KEY_FILE!, "utf8"),
});

const { result, observation } = authrail.observe(
  {
    operationVersionId: reviewedOperation.versionId,
    actionKey: invoice.stableActionKey,
    principalId: authenticatedSession.principalId,
    sessionId: authenticatedSession.id,
    resourceId: invoice.id,
    principalSource: "application_session",
    resourceSource: "application_lookup",
  },
  { invoiceId: invoice.id },
  () => invoiceService.read(invoice.id),
);

const invoiceResult = await result;
const checks = await observation;
```

`result` is the protected function's value or error. `observation` has separate
call and result decisions or errors. The call check starts before the function
but never holds it up. A result check runs only after the function succeeds
and the call check settles. A failed function has no result check.

Use your application's authenticated session to supply `principalId` and
`sessionId`. Resolve `resourceId` in your application and use
`resourceSource: "application_lookup"` only when the reviewed Operation targets
that resource. For an Operation without resource identity, omit `resourceId`
and use `"not_applicable"`. A service-authenticated caller uses
`principalSource: "service_identity"`.

Use one stable `actionKey` for retries of the same business action. A different
action needs a different key. Arguments and successful results must be bounded
JSON objects. The SDK creates the request ID and signs both checks with the
application key; it does not independently verify the person, resource, or
business result you supplied.

## Read the check

| Field | Meaning |
| --- | --- |
| `callDecision` / `resultDecision` | What the active Rails would decide for each covered phase. |
| `callError` / `resultError` | Local validation, sidecar, or response failure. The tool result is separate. |
| `coverage` | Whether the phase was evaluated, uncovered, or unavailable. |
| `recordingStatus: "retained"` | AuthRail saved the report and returned Action/certificate references. |
| `recordingStatus: "queued"` | The sidecar saved the report locally for retry; AuthRail has not retained it yet. |
| `recordingStatus: "unavailable"` | The report is not known to be retained. Investigate the recording gap. |

A would-deny result in Observe mode is **not** a blocked operation. A successful
tool function is **not** evidence that its report was retained. Monitor
`observation` and the deployment's health and logs in AuthRail.

## Trusted context and security

Supply optional `factResolutions` only from reviewed Data source versions and
protected lookups. Supply `trajectory` only from authenticated same-session
history. The SDK signs their exact input digest. It does not fetch provider
data, run a model, judge a Rail, or turn an untrusted claim into an authenticated
fact. Keep provider credentials behind the protected executor and outside the
agent. If an agent can bypass that executor, the deployment is advisory.

## Protect a tool with Enforce

After reviewing the deployment's connection and bypass paths, use
`EnforceClient` inside the application that holds the provider credentials:

```ts
import { EnforceClient } from "@authrail/sdk-node";

const authrail = new EnforceClient(config);
// Reuse operation.actionKey for this business action across process restarts.
const checked = await authrail.enforce(operation, { invoiceId: invoice.id },
  (checkedArguments, execution) => invoiceService.pay(checkedArguments.invoiceId, {
    idempotencyKey: execution.providerIdempotencyKey,
  }));
return checked.result;
```

For a published Guard that requires string processing, register the exact
application-owned handler before calling Enforce:

```ts
const authrail = new EnforceClient({ ...config, guardHandlers: [{
  id: "customer_redactor",
  version: reviewedRedactorSha256,
  kind: "sanitize",
  process: redactCustomerText,
}] });
```

The handler ID, lowercase SHA-256 version, and kind must match the reviewed
Guard. Use deterministic, side-effect-free string handlers. Enforce reads the
current requirements from the authenticated local sidecar, processes copies of
only the reviewed string fields, and signs their before/after digests with the
final decision input. Both the bundle ID and sequence must match the final
phase decision. It checks transformed results before exposing them.
Unavailable plans, missing handlers, conflicting targets, handler failures,
and unsupported isolation block the boundary. A handler has four seconds to
complete; a timed-out Promise may continue in the application, so handlers must
not perform business effects. Call processing is not repeated when resuming an
approved continuation. Observe never runs these handlers. Without configured
handlers, existing calls use the normal evaluation path; the sidecar blocks any
unfulfilled Guard requirement. A signed handler assertion does not independently
verify the handler's implementation or prove sandbox isolation.

The callback runs only after a covered `allow` decision and a signed `started`
receipt have been retained by AuthRail. The SDK checks a successful result
before returning it to the agent.
The included [executable payment example](examples/enforce-payment.mjs) exercises
this boundary against a configured test deployment with a mock provider ledger.
It uses a fixed test action key; use a distinct stable business key per real
payment, replace the fixed principal with authenticated application context,
and keep the provider's own idempotency contract.
For a model-driven attempt, run [the OpenAI Responses example](examples/agent-enforce-payment.mjs)
from the credential-owning application. Set `OPENAI_API_KEY`, `OPENAI_MODEL`,
`AUTHRAIL_AGENT_PROMPT`, `AUTHRAIL_ACTION_KEY`, `AUTHRAIL_PRINCIPAL_ID`,
`AUTHRAIL_SESSION_ID`, `AUTHRAIL_OPERATION_VERSION_ID`, and the sidecar and
executor settings used by the payment example. The application must derive the
principal and session from its authenticated caller and supply a distinct,
stable action key for each business payment. The model receives one mock payment
tool; the protected callback runs only through `EnforceClient`. The script prints
one JSON summary of the attempted call, decision, receipt-backed result, and
mock effect count. A request for 150 mock units reaches the Rail so it can be
denied there; a request for 80 can be allowed by the reviewed example Rail.
It never makes a Stripe payment. Its in-memory mock ledger is
only a local demonstration; a real provider adapter must persist or query the
provider idempotency key when recovering an uncertain outcome.
It stops on denial, missing coverage, approval required, sidecar failure, or a
report that has only been queued. An already retained call with the same action
key also stops until the executor reconciles that Action. After a provider
lookup establishes no effect, report `outcome: "failed"` through `reconcile`,
then call `enforce` again with the same business action key and business
arguments. Fresh facts and trajectory can inform the new Rail decision, which
may require a new approval and
permit. Pass the same `execution.providerIdempotencyKey` to the provider. A
changed effect input needs a new business key. `EnforceBlockedError` identifies
the phase; `effectMayHaveOccurred`
is true for a blocked result because the function has
already run. A function error or lost completion receipt raises
`EnforceOutcomeUnknownError` with `recovery` identifiers. Check the provider
using the same idempotency key; then call `authrail.reconcile({
...error.recovery, providerReference, outcome: "succeeded" })` or use
`outcome: "failed"` only after that check. Keep the recovery identifiers with
the provider request so process loss can be resolved. The SDK never retries a
business effect automatically. A stale attempt appears as unknown in customer
history after one minute and the worker durably marks it unknown.
AuthRail authenticates the registered executor's reconciliation report; the
provider's record is the source of the no-effect determination.

When a retained decision requires approval, catch its `EnforceBlockedError`
and keep that error with the pending workflow. Its `decision.approvalRequestId`
identifies the review request. An approval-capable Enforce call must include
`operation.reviewSummary`, for example `{ title: "Pay invoice", fields:
[{ label: "Amount", value: "400 USD" }] }`. Supply only the few facts a human
needs to decide. Never put raw tool payloads, credentials, or sensitive content
there. The protected application signs the summary digest; AuthRail lists it
only for named reviewers in Rails → Approvals for you. Without a valid summary,
approval remains unavailable. After a named reviewer approves, call
`authrail.resumeApproval(blockedError)` on the same client instance. For a
workflow that crosses requests or restarts, encrypt and retain
`blockedError.approvalContinuation` in protected application storage, scoped to
the original user, organisation, deployment, Action, and business request.
On approval, a new client may call `resumeApprovalFrom(continuation, callback)`
with the original protected callback. Do not obtain fresh model arguments or
create a new Action for that continuation. Both paths claim the original Action
through the sidecar before the callback and check the result before exposure.
A Policy may still report `approval_required` at the result hook because it
evaluates the same business arguments. The SDK releases that retained result
only when the original Action has a claimed permit and the result belongs to
that exact Action. A result denial, missing report, or different Action blocks
exposure even after the mock or provider effect ran.
A lost or rejected permit claim never runs the callback; inspect the Action
before another claim. If the claim response was lost, use
`recoverApprovalFrom(continuation, callback)` to read only the existing,
unexpired, unstarted permit for the same Action, input and executor. This does
not issue a replacement permit. Missing or uncertain recovery blocks the
callback; a start receipt or provider outcome that is already uncertain needs
Action inspection and provider reconciliation. The SDK does not persist a
continuation for the caller.

If the signed Enforce bundle expires or becomes unavailable, protected calls
stop. A tenant manager can switch the deployment back to Observe, renew the
exact published Rails, recheck call and result coverage, and turn on Enforce
again.

Keep the function and provider credentials unreachable from the agent through
other tools, network paths, or secret access. A sidecar decision and a saved
certificate do not independently prove that the callback ran or that no
bypass exists. The approval permit records permission, not execution. A signed
receipt proves what the registered application reported; the provider's actual
record remains the source for reconciliation.

## Work on this SDK

Run `npm ci`, `npm test`, and `npm pack --dry-run`. The public entry point is
`src/index.ts`; the Enforce boundary lives under `src/enforce/`, while Observe
behavior and shared protocol encoding live under `src/observe/`. The package
also includes the current `conformance/v1` fixture corpus for adapter authors. See
[ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and
[CONTRIBUTING.md](CONTRIBUTING.md) for validation rules.

For a sibling checkout of both SDKs and the sidecar, run
`sh scripts/check-sidecar.sh` from `authrail-sdk-go`. This builds this SDK and
exercises both languages against the real sidecar HTTP handlers with generated
keys, a signed fixture bundle and temporary private state. It checks allow,
deny, persisted approval recovery and duplicate-start blocking. Its control
plane is a fixture: it verifies protocol translation without claiming central
persistence, provider effects, complete coverage or release acceptance.


### Report execution outcomes while observing

Observe decisions stay advisory. To retain what the executor actually did,
keep the original `call` returned by `observe` and pass explicit executor
knowledge to `reportObservedExecution(call, outcome)`. The outcome has `event`
(`succeeded`, `failed`, `unknown`, `reconciled_succeeded`, or `reconciled_failed`),
the executor's `providerIdempotencyKey`, and a bounded `providerReference` or
`null`. Use `unknown` when an exception or pending provider response cannot
establish whether an effect happened. A successful rule check is never an
execution outcome. Do not run a business operation again to retry a report.

The method sends signed digests and references only. `recordingStatus: queued`
means the local sidecar persisted delivery; `retained` includes the central
Action and receipt IDs. Outcome reporting never requests permission, changes
an advisory deny, or delays the tool callback. Read observation separately for
call/result check failures; classify the business outcome from the executor's
own evidence. The original prepared call must be retained until reporting is
acknowledged. See the sidecar protocol for historical signature verification.
