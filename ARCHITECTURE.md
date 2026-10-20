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
- AuthRail retains accepted Actions, Observe certificates, Activity Records,
  and customer logs. A sidecar response distinguishes retained, queued, and
  unavailable reporting.

The SDK does not independently establish that an application claim is true or
that every action passed through the hook. Observe never blocks the function.
Missing or invalid checks are coverage gaps, not allow decisions.

## Code layout

- `src/index.ts` is the public package entry point.
- `src/observe/client.ts` owns client configuration, the protected-function
  wrapper, request signing, HTTP exchange, and advisory failure behavior.
- `src/observe/protocol.ts` owns bounded JSON encoding and the exact signed
  protocol representation shared with the sidecar.
- `src/observe/types.ts` owns the public Observe types.
- `test/observe.test.ts` checks signatures, phase ordering, failure behavior,
  and loopback HTTP. The server's isolated connected verifier separately
  exercises Node and Go against one real sidecar and retained deployment.

Protocol changes must stay language-neutral and preserve compatibility with
the sidecar and server. Types alone do not establish wire compatibility.
