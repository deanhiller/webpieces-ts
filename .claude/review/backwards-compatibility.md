# Checklist: no backwards-compatible shims on any webpieces surface

**The policy, in one sentence:** when a webpieces surface changes, the OLD spelling must stop
compiling, and the failure must name the new spelling. No deprecation period, no overload, no
fallback, no alias.

This is the checklist for `backwards-compat-reviewer`. It is a REQUIRED reviewer and it runs on every
PR that touches a framework package, a published API contract, or `webpieces.config.json`.

## Why this repo inverts the normal rule

Every consumer of these surfaces is a coding agent, and an agent picks **whatever typechecks**. That
single fact flips the usual trade-off:

| | a human consumer | an agent consumer |
|---|---|---|
| `@deprecated` tag | strikethrough in the editor, a lint warning they may read | **invisible** — not part of the type, so not part of the decision |
| old spelling still compiles | "I'll migrate next sprint" | picks it, writes it into new code, and asserts in a comment that the new thing does not exist |
| old spelling deleted | an afternoon of mechanical edits | a reliable one-pass codemod — the thing agents are *best* at |

So a soft landing does not buy a migration, it prevents one: **an accepted shape is never migrated.**
The compile error is not the cost of the change, it is the delivery mechanism for it.

The live example this checklist was created from is
[#589](https://github.com/deanhiller/webpieces-ts/issues/589): an agent wrote
`@Authentication(new AuthenticationConfig(true))` — the widest possible grant — onto an **admin**
contract, and then asserted in a comment that the framework had no role support. `@AuthJwt('admin')`
was two hundred lines above the file it was editing. Keeping `AuthenticationConfig` as `@deprecated`
would have fixed the documentation and left the silent over-permissioning fully available.

## Surfaces in scope

Everything a downstream repo can import, call, decorate with, or configure:

- **decorators + contracts** — `packages/core/core-util/src/http/decorators.ts`, everything under
  `libraries/apis/**`, every `*Api.ts`
- **http surfaces** — `packages/http/http-api`, `http-routing`, `http-server`, `http-filters`,
  `http-client`, `http-client-core`, `http-client-node`, `http-client-browser`
- **cloud surfaces** — `packages/cloud/cloudtasks-client` (queue/task enqueue + delivery),
  `packages/cloud/gcp-identity`
- **core surfaces** — `packages/core/core-context`, `core-util`, `core-mock`
- **logging surfaces** — `packages/logging/bunyan`, `packages/logging/winston`
- **tooling surfaces** — `packages/tooling/**`: the eslint rules, the nx executors, the `wp-*`
  commands, and **`webpieces.config.json` keys**
- **every `src/index.ts` barrel** — a barrel is the surface; an export removed from the
  implementation but left in the barrel is the same defect one level out

## The shim shapes — each one is an automatic 🔴

Grep for these, then read the diff around every hit.

### 1. Two spellings of one thing

The headline case, and the one the user named explicitly: **the diff leaves two ways to do the same
thing.** Any of these:

- a new function/decorator/method added while the old one stays exported
- an added overload signature whose only purpose is to keep old call sites compiling
- an optional parameter added so the old arity still works, when the new arity is the intended one
- a second config key that means the same thing as an existing one
- a class kept as a `extends`/`implements` alias of its replacement

🔴 unless the OLD spelling is deleted in the same diff. The verdict text must name both spellings and
the deletion that is missing.

The one legitimate case is two spellings that are genuinely **different decisions** — `@AuthJwt('admin')`
and `@AuthJwtAllRolesAllowed()` are not a shim pair, they are an enumerated set and a deliberately-named
wide case. The test is: can a caller pick wrong and get the same behaviour either way? If yes, it is a
shim.

### 2. `@deprecated` used instead of deletion

**Any new `@deprecated` on a webpieces surface is 🔴.** There is no deprecation period in this repo;
`@deprecated` is a human-facing signal and every consumer here is an agent. Delete it and let the
callers fail to compile.

If the intent is genuinely "this is going away later", that is still a deletion — do it now, and put
the migration in the error text. `grep -n '@deprecated'` over the diff is the whole check.

### 3. A config fallback that accepts the old shape

For `webpieces.config.json` (see the CLAUDE.md section "webpieces.config.json is NEVER released
backwards-compatible"):

- `config.newKey ?? config.oldKey` — 🔴
- an alias table applied before validation — 🔴
- "still accepted until every consumer migrates" — 🔴
- a moved/renamed/deleted key whose read path is still present — 🔴

The correct shape is: an entry in `RETIRED_CONFIG_KEYS`
(`packages/tooling/rules-config/src/retired-config-keys.ts` — the ONE place a dead key may be named),
the old read path deleted in the same change, and a loader error that says **"X moved to Y"**.

"Rejecting it would deadlock the consumer" is not a valid justification and you should not accept it:
editing `webpieces.config.json` is always permitted even while the config is invalid, and
`pnpm install` is always permitted. Say so in your verdict if the PR argues it.

### 4. A runtime `throw` standing in for a type that cannot express the bad state

A validation that exists only because the signature admits a contradictory combination is a signal the
signature is wrong. `@Authentication` needed a runtime `throw` for `authenticated: false` + roles;
`@Public()` and `@AuthJwt(...)` cannot express it at all. Prefer the version where the error is
unrepresentable. 🟡 when the throw is defensible, 🔴 when the union or the arity could have carried it.

### 5. A widening that is an ABSENCE rather than a token

An empty array, an omitted argument, or a falsy default that means "allow everything" is the same class
of defect: the permissive path becomes the shortest thing to type and it is not greppable. The wide
case must be its own named token — `@AuthJwtAllRolesAllowed()`, not `@AuthJwt()`.

### 6. An error message that teaches the removed API

Whenever a surface is deleted, every message, docstring and `responsibilities.md` line that prescribed
it must be updated in the same diff. The framework's own "you forgot authorization" error used to hand
the caller `@Authentication(new AuthenticationConfig(...))` — which is a plausible route by which the
footgun propagated in the first place. 🔴 for a message left naming a removed symbol.

## What a good removal diff looks like

Check the removal is COMPLETE, because a half-removal is a shim by accident:

1. the definition is deleted
2. every barrel export of it is deleted
3. every call site is migrated (`grep` the old symbol over `packages apps libraries`, excluding
   `node_modules` and `*.d.ts` — the result should be empty or only the new docs explaining the removal)
4. every error string, docstring, `README.md` and `responsibilities.md` that named it is updated
5. a test asserts the NEW error text and asserts the old symbol is not named
6. the release-ordering rule is respected: for tooling, source and the `webpieces.config.json` entry
   that uses it ship in SEPARATE PRs, because the running validator is a release behind (see the
   "Published vs local source" section of CLAUDE.md)

## Writing your verdict

Per the review-checklist protocol, write `.webpieces/pr-review/<branch>/review-backwards-compat-reviewer.json`
at the path your instructions file names.

- 🟢 `green` — no surface changed, or the surface changed and the old spelling is gone
- 🟡 `yellow` — a judgment call worth a human's eyes (a defensible runtime throw, a borderline
  two-spelling pair); publishes your reasoning on the PR without blocking
- 🔴 `red` — any of the six shapes above. Your `output` must name **the file, the old spelling, and the
  deletion or compile error that should have replaced it**, because that text is what the coding agent
  will act on.

Do not soften a `red` to a `yellow` because the PR says the shim is temporary. That is the exact
argument that licensed the fallbacks which then kept this repo's own config on dead shapes for
releases.
