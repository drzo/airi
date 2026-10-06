# AIRI Live2D stage

This package renders Live2D models in AIRI's web and desktop stages. AIRI owns the selected model, motions, expressions, and speech. It does not own a DTE identity.

## DTE local stage bridge

`src/composables/live2d/dte-stage-bridge.ts` accepts short-lived presentation cues from a **separate local DeltEcho window**. It does not read Delta Chat messages or modify either app's identity store.

The bridge opens only when all conditions hold:

1. AIRI runs at a loopback host, inside an iframe or a popup opened by DeltEcho.
2. The stage URL contains `dteBridge=1`, `dteModelId=miara`, and the exact loopback DTE origin, for example `dteParentOrigin=http://localhost:3000` (URL-encoded).
3. The selected Live2D model loads from a ZIP URL or a `blob:` ZIP. AIRI hashes the **actual selected archive bytes** with SHA-256. The archive must be at most 64 MiB.
4. AIRI accepts Eventa `window-message` traffic only from the specific parent/opener window at that loopback origin. The sender must independently pin the archive hash.

The Eventa channel is `airi:dte:stage:v1`. Its messages are:

- `airi:dte:stage:ready:v1`: `{ modelId, modelSha256 }` from AIRI after hashing the loaded ZIP.
- `airi:dte:stage:hello:v1`: an empty request from the pinned DTE window to resend `ready` if it missed the first notice.
- `airi:dte:stage:cue:v1`: a DTE `schemaVersion: 1`, `kind: 'dte.presentation.cue'` payload with its selected model ID and SHA-256, a unique lease ID, `observedAt`, `expiresAt`, `expressionName: null`, `motion: null`, and sparse normalized `pose` axes.
- `airi:dte:stage:ack:v1`: `{ leaseId, accepted }` from AIRI after validating the cue.
- `airi:dte:stage:release:v1`: `{ leaseId }` to release only the named DTE lease.

Use `@moeru/eventa/adapters/window-message` on both sides. Raw `postMessage` JSON is **not** this Eventa protocol. Accepted pose axes are `eyeX`, `eyeY`, `eyeSquint`, `headX/Y/Z`, and `bodyX/Y/Z`. AIRI applies them after manual motion and before lip-sync. AIRI retains mouth, audio, model position, breath, and all non-DTE controls. Named expression and motion requests are not supported in this pilot. AIRI rejects unknown fields, mismatched archives, malformed or stale samples, out-of-range values, released lease IDs, and lease lifetimes above three seconds. Closing the model or losing document visibility releases the current cue.

Import the existing **generic Miara** ZIP through AIRI's model selector before testing. Do not label this archive as a new DTE-specific Cubism export. Later appearance and gesture tuning can use artist-approved source material without transferring core-self authority to AIRI.

For local tests, use the stage package's Vitest suite and typecheck. Test real popup/iframe delivery against a local DeltEcho page at its configured loopback port. Verify actual model loading, expression/motion resources, speech priority, model switch, expiry, and close. The source-level unit tests do not establish those runtime results.
