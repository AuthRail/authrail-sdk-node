<p align="center">
  <img src="assets/authrail-logo.png" alt="AuthRail" width="120" />
</p>

# AuthRail Node SDK

AuthRail helps organisations control what connected AI agents may do and
understand what happened when they acted. In the workspace, you describe an
action, publish rules for it and review the decisions and completion reports.
Those rules are called **Rails**.

This SDK connects a Node.js function to those Rails. For example, you can wrap an
invoice reader so each agent request and returned invoice are checked by a
**sidecar**, a small service running beside your application. The application
keeps the business function and its provider credentials; the sidecar evaluates
the selected rules and sends decision records to AuthRail.

Start in **Observe** to see how the rules apply while the function continues
running. Switch to **Enforce** when the function should wait for permission;
the SDK also checks its result before returning it to the agent. A decision
explains permission, while a completion report describes what the application
says it did. When an operation affects an external provider, check that provider’s
record to establish its effect independently.

[Documentation](https://docs.authrail.io) ·
[Sidecar](https://github.com/AuthRail/authrail-sidecar) ·
[Node.js SDK](https://github.com/AuthRail/authrail-sdk-node) ·
[Go SDK](https://github.com/AuthRail/authrail-sdk-go) ·
[Python SDK](https://github.com/AuthRail/authrail-sdk-python)

## Choose a version

The install command below selects SDK **0.1.1**, which supports Observe and
Enforce, saved approval continuations, reconciliation, custom Guard handlers
and explicit fact readers. The [first-application guide](https://docs.authrail.io/docs/getting-started)
uses this release with a simple Policy Rail and a local invoice reader.

Some sections below also describe newer repository source. Automatic
Rail-owned Contextual AI, expanded built-in Guards and automatic Data reader
bindings are not part of SDK 0.1.1. Check
[compatibility](https://docs.authrail.io/docs/compatibility) before enabling those
requirements. The setup executable and native Runtime are version **0.2.0**,
while its Docker installer selects Runtime **0.1.0**; they have separate version
identities.

## What you need

Prepare the workspace and sidecar before adding the wrapper to your application:

1. Create an AuthRail account if you need one, then sign in and open your
   organisation's workspace. You need access to manage its AI Inventory and
   Runtime configuration. The
   [first-application guide](https://docs.authrail.io/docs/getting-started) walks
   through these workspace steps.
2. Add or select the AI system in **AI Inventory** and confirm its identity.
   Create and review the action it will request, including its inputs and
   results. Copy its **Operation Version ID** for your code so the SDK can use the
   input and result description you confirmed.
3. Publish the Rails for that action, then create an **Observe deployment**
   using the confirmed AI system and the published Rail versions. A deployment
   identifies the application setup whose decisions you want to track.
4. Download the [released sidecar setup executable](https://docs.authrail.io/docs/native#1-download-the-sidecar).
   Follow guided setup with the API address supplied by your installation
   administrator. Choose Docker for a container application or native for a
   host application. Setup creates the private keys, tokens and helper files
   and registers the public key with AuthRail. Your application operator
   should keep these files private.
5. Use Node.js 20 or newer. Get the caller, session and target record from your application’s
   authentication and resource lookups, as described below.

The SDK signs with the saved `executor-private.pem`. The sidecar holds only
its public key. `adapter-token` connects the application to the local sidecar;
`deployment-token` connects the sidecar to AuthRail. Keep both tokens, private
keys and provider credentials outside the agent and browser bundle.

The SDK runs inside your Node application. The sidecar is a separate running
process; installing or building this SDK does not start it. The local URL
`http://127.0.0.1:7078` works when they share a network namespace. With Docker,
follow the sidecar guide to put the protected application in that namespace;
`127.0.0.1` in an unrelated container points at that container itself. For a Go
application, use the [Go SDK](https://github.com/AuthRail/authrail-sdk-go) with
the same sidecar protocol.

## Install

Install the [npm package](https://www.npmjs.com/package/@authrail/sdk-node) from
your application's directory:

```bash
npm install @authrail/sdk-node@0.1.1
```

Your application can then import `@authrail/sdk-node`, as shown below. Installing
the package does not start the sidecar or configure your AuthRail deployment.

<details>
<summary>Build from source when contributing</summary>

```bash
git clone https://github.com/AuthRail/authrail-sdk-node.git
cd authrail-sdk-node
npm ci
npm run build
```

This compiles TypeScript into `dist/`. To try your changes in another application,
run `npm install /absolute/path/to/authrail-sdk-node` from that application.
See [Contributing](CONTRIBUTING.md) for checks.

</details>

Continue with [Observe your first action](#observe-your-first-action). The
later sections cover optional discovery and source facts when your action
needs them.

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
console.log(invoiceResult);
console.log(checks.callDecision?.outcome, checks.resultDecision?.outcome);
console.log(checks.callError, checks.resultError);
```

This example shows where to place the wrapper in an existing application.
`organisation`, `deployment` and `reviewedOperation` come from its configuration;
`invoice`, `authenticatedSession` and `invoiceService` come from the business
code. Adapt them to your own types and make sure the confirmed action describes
the input and result fields you send. For a complete runnable file-reading
program, use the [Node.js guide](https://docs.authrail.io/docs/node).

With a healthy Observe deployment, the function returns the invoice and the
checks contain call and result decisions. Their outcomes depend on your
published Rails. `recordingStatus: "retained"` means AuthRail stored that check;
`"queued"` means the sidecar saved it for later delivery. Open the deployment's
Runtime history in your workspace to inspect retained decisions. If either
check has an error, inspect the sidecar's health and credentials; the invoice
function still runs in Observe.

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

In Observe, a deny decision can appear beside a successful function result
because the decision is advisory. Check `observation` and the deployment logs
separately to see whether the report reached AuthRail.

## Discover and supply reviewed facts

A rule may need information that the agent’s arguments cannot establish. For
example, before paying an invoice, it may need a balance from the correct
account. A **Context Source Version** describes that lookup, including the
account, record key, expected value and freshness limit. Configure the reader
from that published source so the agent cannot substitute a URL or account.

`lookupStripeInvoiceStatus` reads the account using the application’s Stripe
credential, verifies that it matches the source and reads the invoice status.
For Stripe Connect, both requests use the selected account in `Stripe-Account`.

`lookupQuickBooksInvoiceBalance` reads `Invoice.Balance` for one invoice in the
configured QuickBooks Online realm. Your application supplies its OAuth access
token. Use `sandbox: true` for an Intuit test company; otherwise the helper uses
the production endpoint. A different invoice or invalid balance returns
`untrusted`, while a timeout, redirect or provider failure returns `unavailable`.
The balance is in the invoice’s currency. If the rule needs a currency-qualified
threshold, provide a separate source for currency rather than assuming one.

Your application owns provider sign-in and credential storage. For QuickBooks,
match the OAuth realm to the configured account, store the tokens privately and
refresh them before reading when needed. Serialize refreshes for each realm
and save the new access and refresh tokens together. Expired, revoked or
mismatched grants leave the lookup unavailable and need reconnection. Keep the
tokens, OAuth codes and provider responses inside the protected application;
the SDK takes a token for the read rather than managing consent or refresh.
Stripe keys follow the same private, account-scoped ownership.

For your own service, `lookupCustomerFact` accepts a read callback and
`newCustomerAPIReader` provides a fixed HTTPS GET reader. These helpers return
`ok`, `unavailable` or `untrusted`, along with the source and lookup information
needed to check the fact. Attach the resolution to the Operation as
`factResolutions`. Database and API credentials remain in your application.

For optional Inventory discovery, `discover` uses a short-lived tenant setup
key to find an AI Inventory item and deployment. A manager still confirms the
item and configures the separate deployment credential. Keep the discovery key
private; finding an Inventory item is not permission to perform an action.

```ts
const fact = await lookupCustomerFact(reviewedSource, invoice.id,
  async (key, signal) => privateInvoiceLookup(key, { signal }));
const checkedOperation = { ...operation, factResolutions: [fact] };
```

Use `traceparent` on an Operation only when it comes from the protected
application's trace context. The sidecar forwards it for correlation; it
does not prove caller identity, permission, or execution.

## Use AuthRail Contextual AI

The integration in this section is available in current source, but not in
published SDK 0.1.1. Choose a compatible released SDK and Runtime before using
it in an installed application.

Some rules need to understand meaning as well as compare values. For example,
a release rule might ask whether a code change weakens authentication. Enable
**AuthRail Contextual AI** on the Guard or Policy Rail, describe the rule and
review the question, permitted fields and answer that AuthRail prepares. Test
those choices before publishing the Rail.

During a call or result check, the SDK obtains that assessment from the sidecar,
applies any required local processing and selects the permitted material. It
sends that material through the sidecar to AuthRail for interpretation. AuthRail
returns a signed finding, which the sidecar verifies against the request,
caller, material and Rail version before using it in the rule. AuthRail operates
the interpretation service, so your application does not need model credentials,
a prompt or a separately configured extractor.

If Contextual AI is off for the Rail, it sends no contextual request. If the
assessment is uncertain, material is missing or the service is unavailable, the
rule cannot pass using an invented answer. Ordinary authentication, data lookups
and human approval still apply; interpretation supplies information to a rule,
not permission to perform the action.

Review disclosure before publication because AuthRail receives the selected
material for transient processing. Normal Actions, logs and traces exclude that
material and retain the assessment status and finding instead. The
[Contextual AI guide](https://docs.authrail.io/docs/facts) explains this flow
and its failure handling.

## Trusted context and security

Supply `factResolutions` from the configured Data source and protected reader,
and supply `trajectory` from the application’s saved history for the same
session. The SDK signs this context with the request so later changes cannot
alter what was checked. Your application still establishes the caller and
resource through authentication and lookups; an agent’s statement that it
read or approved something is not that evidence.

Keep provider credentials in the application that owns the business function.
The agent should reach it only through the SDK wrapper. If it can call the
provider directly or use another unprotected route, treat the installation as
advisory until that bypass is closed.

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

A Guard identifies its handler by ID, kind and a lowercase SHA-256 version
fingerprint. Register the same values in the application. During Enforce, the
SDK obtains the plan from the sidecar and processes copies of the specified
string fields. It signs the input and output digests, then checks that the
final decision uses the same bundle ID and sequence. Result processing happens
before output is returned to the agent.

Keep handlers deterministic and free of business effects. They have four
seconds to finish, but a timed-out Promise may continue running locally. A
missing handler, failed plan, conflicting field, processing error or unsupported
isolation requirement stops Enforce. Approval resumption reuses processed call
input, while Observe does not run handlers. The signed processing report
identifies what the application asserted; it is not an independent inspection
of handler code or proof of sandbox isolation.

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
Enforce stops the callback when the request is denied, needs approval, lacks
coverage or cannot obtain a report saved by AuthRail. If the same action key
already has a started attempt, inspect and reconcile that attempt before
considering another one.

If a provider lookup confirms no effect, report `outcome: "failed"` through
`reconcile`. You can then ask for a new decision with the same business action
key and arguments, refreshing facts and session history if needed. That new
decision may require another approval. Pass the original
`execution.providerIdempotencyKey` to the provider; a changed business request
needs its own key.

`EnforceBlockedError` identifies whether the call or result check stopped.
For a result block, `effectMayHaveOccurred` is true because the function has
already run. A callback error or lost completion acknowledgement instead raises
`EnforceOutcomeUnknownError` with `recovery` information. Save that information
with the provider request so it survives process loss.

Use the saved idempotency key to establish the provider outcome, then call
`authrail.reconcile({ ...error.recovery, providerReference, outcome: "succeeded" })`
or use `outcome: "failed"` after confirming no effect. Until then, leave the
outcome unknown rather than automatically retrying the operation. Stale attempts
appear as unknown in customer history after one minute, and the worker saves
that state. AuthRail authenticates the application’s reconciliation report;
the provider record supplies the independent basis for it.

### Save and resume an approval

When the decision requires approval, catch `EnforceBlockedError` and keep it
with the pending workflow. Its `decision.approvalRequestId`
identifies the review request. An approval-capable Enforce call must include
`operation.reviewSummary`, for example `{ title: "Pay invoice", fields:
[{ label: "Amount", value: "400 USD" }] }`. Include the few facts the reviewer needs to decide, leaving credentials and
raw sensitive payloads out of the summary. The protected application signs the summary digest; AuthRail lists it
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
