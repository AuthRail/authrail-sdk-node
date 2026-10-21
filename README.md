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
a signed fact resolution. The model supplies context, not a Rail decision.
AuthRail receives bounded provenance and status, not the raw document or
fact value. The callback must honor its abort signal; the SDK cannot forcibly
stop an arbitrary callback that ignores cancellation.

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

The callback runs only after a covered `allow` decision and a signed `started`
receipt have been retained by AuthRail. The SDK checks a successful result
before returning it to the agent.
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
`authrail.resumeApproval(blockedError)` on the **same** client instance. It
claims the original Action once through the sidecar, runs the original protected
callback, and checks the result before exposure. A lost or rejected claim does
not run the callback and cannot be retried through the same error. Reconcile the
Action before taking another step. Process loss also requires reconciliation;
the SDK does not persist the pending callback or claim state.

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
