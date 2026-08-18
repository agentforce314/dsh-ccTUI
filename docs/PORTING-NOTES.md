# Porting Notes

Running log of deliberate deviations from the pristine `reference_projects/clawcodex/ui-tui`
sources. Everything not listed here is a verbatim copy.

## Stage 3 — app source copy

- `src/` and `scripts/{build,build-dev,profile-tui}.mjs` copied byte-identical from ui-tui
  (verified with `diff -r`).
- `vitest.config.ts`: `testTimeout` raised to 120s. The upstream cursor-drift regression test
  walks every typing prefix through a real Ink render and needs >5s on this hardware (WSL2);
  it passes given time.
- **7 tests marked `it.skip` with a `KNOWN-SKEW(upstream)` comment.** All 7 fail identically in
  the pristine ui-tui checkout with its own lockfile (verified 2026-08-18), i.e. the upstream
  tests drifted from the upstream sources before the snapshot was taken; the sources are the
  authority for look/feel, so the stale expectations are skipped rather than "fixed":
  - `createGatewayEventHandler.test.ts` — expects `Patch("foo.ts")`-style quoted tool-trail
    labels and an `Args:` verbose block that `buildToolTrailLine` no longer emits.
  - `statusRule.test.ts` (2) — expects a `cost` segment that `statusBarSegments` no longer
    returns.
  - `useConfigSync.test.ts` (2) — expects the default indicator style to be `kaomoji`; the
    source default is `star`.
  - `virtualHeights.test.ts` (1) — expects a different wrap estimate for compound user prompts.
- `slashParity.test.ts` shells out to the Python `clawcodex_cli` package to compare slash
  catalogs and self-skips ("best effort") when the module is missing, as it is here.

Revisit: when a stage touches one of these areas, reconcile the skipped expectation with the
observed behavior instead of leaving it skipped.

- Local flake: `src/__tests__/modelPicker.test.tsx` ("offers auto plus the levels the model
  accepts") can fail under full-suite parallel load on slow machines (20ms stdin delays); it
  passes consistently in isolation. Watch CI; bump the test's delay if it flakes there too.
