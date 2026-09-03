# NO webpieces surface is released backwards-compatible

Moved verbatim out of `CLAUDE.md`. Read this when you change ANY surface -- a decorator, an `*Api.ts`,
a `src/index.ts` barrel, anything under `packages/**`, or a `webpieces.config.json` key.

### NO webpieces surface is released backwards-compatible

**RULE: when a webpieces surface changes, the OLD spelling must STOP COMPILING, and the compile error must
name the new spelling. No deprecation period, no overload, no fallback, no alias — on any surface.**

The config section below is the oldest instance of this rule, not a special case. It applies identically to
decorators and API contracts (`core-util/src/http/decorators.ts`, `libraries/apis/**`, every `*Api.ts`), the
http surfaces (`http-api`, `http-routing`, `http-server`, `http-filters`, `http-client*`), the cloud
surfaces (`cloudtasks-client` queue/enqueue/delivery, `gcp-identity`), `core-context` / `core-util` /
`core-mock`, the logging adapters, all of `packages/tooling/**`, and **every `src/index.ts` barrel** — a
barrel is the surface, so an export left behind after the implementation is deleted is the same defect one
level out.

**Why this repo inverts the normal rule: an agent picks whatever typechecks.** `@deprecated` is a
human-facing signal — strikethrough in an editor, a lint warning someone might read. It is not part of the
type, so it is invisible at the moment an agent decides what to write. The consequence is not "slower
migration", it is **no migration**: an accepted shape is never migrated. And the upgrade side is the cheap
side now — a mechanical rewrite across a repo is exactly what agents do reliably in one pass. So the compile
error is not the cost of the change; it IS the delivery mechanism for it.

Issue #589 is the live proof: an agent wrote `@Authentication(new AuthenticationConfig(true))` — the widest
possible grant — onto an **admin** contract, then asserted in a comment that the framework had no role
support. `@AuthJwt({roles: ['admin']})` was two hundred lines above the file it was editing. Deprecating
`AuthenticationConfig` would have fixed the docs and left the silent over-permissioning fully available.
Deleting it turned every such call site into a compile error.

**The six shim shapes that are an automatic reject** (full detail, with what to grep, in
`.claude/review/backwards-compatibility.md`):

1. **Two spellings of one thing** — a new API added while the old one stays exported; an overload or an
   optional parameter that exists only to keep old call sites compiling; a second config key meaning what an
   existing one means; a class kept as an alias of its replacement. The test for whether a pair is a shim:
   *can a caller pick either one and get the same behaviour?* If yes it is a shim. Better still, make the
   TYPE unsatisfiable in the bad cases so there is exactly one spelling per decision — `JwtRoles` does
   this: `@AuthJwt({roles:['admin'], allRolesAllowed:false})` does not compile, precisely because it would
   be a second spelling of a decision that already has one.
2. **`@deprecated` instead of deletion** — any new `@deprecated` on a surface. Delete it and let callers fail.
3. **A config fallback accepting the old shape** — the section below.
4. **A runtime `throw` standing in for a type that cannot express the bad state** — the throw is evidence the
   signature is wrong. Always ask whether a discriminated union could delete it. `JwtRoles` is the worked
   example: `roles?: never` on the wide branch and a non-empty tuple `readonly [string, ...string[]]` on the
   narrow one make every contradictory or under-specified combination a COMPILE error, so the validation is
   deleted rather than kept as a backstop. Pin it with one `@ts-expect-error` per bad case — tsc fails the
   build with TS2578 if any ever starts compiling. **Put those in a COMPILED file, never a `.spec.ts`:**
   `tsconfig.lib.json` excludes specs and vitest strips types with esbuild, so a `@ts-expect-error` in a spec
   is inert and the suite passes either way. See `core-util/src/http/AuthJwtCompileAssertions.ts`.
5. **A widening that is an ABSENCE rather than a token** — an empty array / omitted argument / falsy default
   that means "allow everything" makes the permissive path the shortest thing to type and impossible to grep.
   Name it: `@AuthJwt({allRolesAllowed: true})`, so `grep -rn allRolesAllowed` lists every wide endpoint.
   Close the side doors too — the first cut of this closed `@AuthJwt` and left `@Auth({})` reaching the
   identical grant, which is why `@Auth` was folded into `@AuthJwt`. One decorator per credential kind.
6. **An error message or doc that teaches the removed API** — the framework's own "you forgot authorization"
   error used to hand the caller `@Authentication(new AuthenticationConfig(...))`, which is a plausible route
   by which that footgun spread. Every message, docstring, `README.md` and `responsibilities.md` naming a
   removed symbol is updated in the SAME diff.

**Enforcement:** `backwards-compat-reviewer` is a REQUIRED review checklist
(`commands.pr-gate.checklists` in `webpieces.config.json`) on every PR touching `packages/**`,
`libraries/apis/**`, any `*Api.ts`, or the config. A red verdict from it blocks the PR, and its `output`
names the file, the old spelling, and the deletion that should have replaced it. Do not argue a shim past it
on the grounds that it is temporary — that is the argument that kept this repo's own config on dead shapes
for releases.

Deleting a surface is only DONE when: the definition is gone, every barrel export is gone, every call site is
migrated (grep the old symbol over `packages apps libraries`), every message/doc that named it is updated,
and a test asserts the NEW error text and that the old symbol is not named.

### webpieces.config.json is NEVER released backwards-compatible

**RULE: when a config key moves, is renamed, or is deleted, the loader REJECTS the old shape with an error
naming the destination. Never add a fallback that accepts both.**

No `?? legacyKey` chain, no alias table applied before validation, no "still accepted for back-compat until
every consumer migrates". This is safe here in a way it is not for a normal library, because of who the
consumer is: **every reader of this file is a coding agent.** The config is validated on startup, the agent
is handed the exact edit, and it applies it in one pass — so the upgrade is seamless *without* shipping a
compatibility layer. Error text SHOULD say "X moved to Y"; that instruction is what makes the fallback
unnecessary.

A hard rejection can never wedge a repo, which is what makes this safe:
- editing `webpieces.config.json` is **always** permitted, even while the config is invalid,
- `pnpm wp-prune-unknown-config` is an **L0 cure**, so the mechanical deletion of keys no validator knows
  runs from inside the block as well.

`pnpm install` is permitted too (installer bypass), but it is **not** the cure for a validation error — the
version-drift guard denies every tool call before the validator runs, so a validation error on screen means
the pin and `node_modules` already agree.

So **"rejecting it would deadlock the consumer" is not a reason to add a fallback.** It is not true, and it
is the exact argument that licensed the fallbacks which then kept this repo's own config on dead shapes for
releases (an accepted shape is never migrated).

**Where it lives:** retirements go in `RETIRED_CONFIG_KEYS` (`packages/tooling/rules-config/src/retired-config-keys.ts`)
— the ONE place a dead key may be named — and you delete its read path in the same change.
`retired-config-keys.spec.ts` and the end-to-end loop in `load-config.spec.ts` assert every entry actually
fails the load, so re-adding a fallback turns them red.

This is about config SHAPE, and does not soften the release-ordering rule above: source and the config that
uses it still ship in separate PRs, because the running validator is a release behind.

**Corollary for instructions generally:** webpieces owns the `wp-*` workflow, and this file must POINT
AT it rather than restate it. Any path, filename or command output hand-copied into CLAUDE.md drifts
out from under us silently on the next release — a copied `review.json` path did exactly that and sent
agents writing to a file nothing reads. Name the tool; let the tool print the details.
