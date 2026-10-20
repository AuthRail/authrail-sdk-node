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

Enforce-mode blocking, approvals, execution receipts, and independent
interception proof are outside this Observe client. Do not use it as an
Enforce adapter.

## Work on this SDK

Run `npm ci`, `npm test`, and `npm pack --dry-run`. The public entry point is
`src/index.ts`; Observe behavior, protocol encoding, and types live under
`src/observe/`. See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and
[CONTRIBUTING.md](CONTRIBUTING.md) for validation rules.
