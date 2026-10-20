# Contributing

This package implements the Observe adapter. Keep its behavior
aligned with the AuthRail Runtime protocol, sidecar, server, and Go SDK rather
than adding a separate policy interpretation in Node.

## Local checks

Use Node.js 20 or newer.

```bash
npm ci
npm test
npm pack --dry-run
```

`npm test` builds TypeScript, checks the test types, and runs the focused
Observe tests. The package exports only built files from `dist/`. Do not hand
edit generated JavaScript or declarations.

## Change boundaries

- Keep `src/index.ts` a small public entry point; implementation stays under
  the feature that owns it.
- Preserve the exact signed JSON field order and Go-compatible encoding.
  Change fixtures and integration verification when the protocol changes.
- Preserve advisory Observe behavior. A check failure must not turn into a
  tool failure, and a would-deny decision must not claim enforcement.
- Keep application and provider secrets out of tests, examples, and telemetry.
- Update README behavior and failure guidance with any public API change.

The workspace has separate Git repositories. Do not assume an SDK change also
ships a sidecar or server change.
