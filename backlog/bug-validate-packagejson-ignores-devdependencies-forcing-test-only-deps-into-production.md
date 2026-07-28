# BUG: validate-packagejson ignores devDependencies, forcing test-only packages into the PRODUCTION dependency closure (0.4.459)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.459`
**Severity:** High — **the tool forces a security-relevant mistake and then enforces it**. A test-only
package imported by a `*.spec.ts` must be listed in `dependencies`, so it lands in the production
container. In the consuming repo this shipped **auth-bypass hooks** to production.

## Symptom

`@myorg/test-support` — whose entire surface is test machinery — sits in `dependencies` (NOT
`devDependencies`) of all four servers **and** of `company-svc-core`, the shared bootstrap library every
server embeds. No production file imports it; the only importers are `*.spec.ts`.

Because the servers' Dockerfiles build their runtime `node_modules` with
`pnpm --filter=<svc> deploy --prod`, which installs exactly the `dependencies` closure, the image
contains:

- `TestJwtHook` / `TestOidcHook` — authentication **bypass** hooks
- `testJwtToken`, `TEST_OIDC_TOKEN` — canned credentials
- `InMemoryFirestore` — a fake datastore
- the `@webpieces/core-mock` engine

Inert in practice (production wiring binds none of them), but credential-bypass helpers have no
business in a production image, and it is exactly the kind of thing a container scan or an auditor will
(rightly) escalate.

Moving it to `devDependencies` — the correct fix, and one that makes `pnpm deploy --prod` omit it —
**fails CI**:

```
❌ Package.json validation failed!
  Project company-svc-core (libraries/node/company-svc-core/package.json) is missing dependencies: test-support
```

So the tool actively prevents the fix.

## Root cause

`packages/tooling/nx-webpieces-rules/src/lib/package-validator.ts` (`package-validator.js:27-28` in the
published build):

```js
// Collect ALL dependencies from package.json
for (const depType of ['dependencies', 'peerDependencies']) {
```

`devDependencies` is never read. The nx graph, meanwhile, derives edges from ALL TypeScript sources
**including specs** — so a spec-only import shows up as a graph edge that can only be satisfied by
`dependencies`. The two halves disagree about what a "dependency" is, and the stricter half wins.

## Suggested fix

1. **Read `devDependencies` when classifying.** Add it to the `depType` loop so a package declared
   there counts as declared. Minimal change; fixes the reported symptom.

2. **Better: match the dependency KIND to how the import is reached.** If a graph edge exists only
   because of `*.spec.ts` / `*.test.ts` / `__tests__` files, then `devDependencies` should be the
   REQUIRED home and listing it in `dependencies` should itself be a violation ("test-only package in
   the production closure"). That turns today's trap into a guardrail — which matters because the
   current behaviour is invisible: nothing tells you the image grew a test harness.

3. Whichever is chosen, `describe`-level output should say which kind it expects and why, so the fix
   is obvious rather than a guess.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/package-validator.ts:27-28` — the `depType` loop that omits `devDependencies`
- `packages/tooling/nx-webpieces-rules/src/lib/package-validator.ts:132` — the "missing dependencies" error and its `Fix:` hint, which currently tells you to add it to `dependencies`
- `packages/tooling/nx-webpieces-rules/src/executors/validate-packagejson/executor.ts:28-49` — reporting

## Acceptance check

1. A package imported ONLY by `*.spec.ts` and declared in `devDependencies` passes `validate-packagejson`.
2. A package imported by production source and declared ONLY in `devDependencies` still FAILS (the
   check must not become permissive in the other direction).
3. Ideally: a test-only package declared in `dependencies` is reported, so the production closure stays
   clean by default.

---

### Consuming-repo status (context)

`ctoteachings/monorepo3` cannot apply the real fix while this stands, so each server's Dockerfile now
deletes the package from the runtime image after the relink step:

```dockerfile
RUN rm -rf node_modules/@myorg/test-support dist/libraries/test-support
```

That is a workaround at the wrong layer — it keeps the production image clean but leaves the dependency
graph lying about what is production code. It should be deleted once this is fixed.
