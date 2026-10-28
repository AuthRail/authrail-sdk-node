# Architecture

The Node SDK connects a protected application to a customer-side AuthRail
sidecar. It is an adapter, not a policy engine or an AuthRail-hosted decision
endpoint.

## Boundaries

- The application authenticates the caller, resolves the target, owns provider
  credentials, and executes the business function.
- The SDK freezes and bounds application context, signs its input digest and
  identity claims with the application's Ed25519 key, and sends call/result
  checks to the loopback sidecar. It holds no AuthRail deployment credential.
- The sidecar verifies the application proof, evaluates the active signed Rails,
  and reports bounded decision metadata to AuthRail. Its durable queue handles
  interrupted report delivery.
- AuthRail retains accepted Actions, decision certificates, Activity Records,
  and customer logs. A sidecar response distinguishes retained, queued, and
  unavailable reporting.

The SDK does not independently establish that an application claim is true or
that every action passed through the hook. Observe never blocks the function.
Enforce requires a covered, centrally retained allow and an authenticated
`started` receipt before invoking the callback. The callback receives a stable
provider idempotency reference derived from the Action. The SDK reports
completion or uncertainty separately from the result check; a failed result
check cannot undo an effect. Missing or invalid checks never become allow
decisions. Unknown outcomes require an executor-owned provider lookup and a
signed reconciliation report; the SDK never retries the effect itself.
After an authenticated no-effect reconciliation, a caller may invoke Enforce
again with the same action key and business arguments. The new signed call ID
is its attempt ID; current Rails and any required approval are checked anew.

Configured Guard processing remains at the protected application boundary.
The SDK reads exact requirements from the authenticated sidecar, resolves a
registered handler by ID, version digest, and kind, and changes only copied
reviewed string targets. The signed final evaluation binds processing evidence
and the exact bundle; a stale plan, missing handler, or processing failure cannot
authorize execution or result exposure. Call evidence stays in persisted approval
continuations and result checks. Observe never transforms content. Isolation
requires a separate supported protected boundary and is not supplied by this
SDK's string handlers.

## Code layout

- `src/index.ts` is the public package entry point.
- `src/observe/client.ts` owns client configuration, the protected-function
  wrapper, request signing, HTTP exchange, and advisory failure behavior.
- `src/enforce/client.ts` owns the fail-closed protected callback boundary.
- `src/enforce/guard.ts` validates processing requirements and applies exact
  application-owned string handlers before final evaluation.
- `src/observe/protocol.ts` owns bounded JSON encoding and the exact signed
  protocol representation shared with the sidecar.
- `src/observe/types.ts` owns the public Observe types.
- `test/observe.test.ts` checks signatures, phase ordering, failure behavior,
  and loopback HTTP. The server's isolated connected verifier separately
  exercises Node and Go against one real sidecar and retained deployment.

Protocol changes must stay language-neutral and preserve compatibility with
the sidecar and server. Types alone do not establish wire compatibility.
