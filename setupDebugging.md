# Setup Debugging: ai-hook-rules auto-install attempts

> **⚠️ HISTORICAL — SUPERSEDED.** This is a dated journal of an *abandoned* approach: auto-installing
> the hook via a `pnpm install` **postinstall** bridge (`.webpieces/ai-hooks/claude-code-hook.js`).
> None of that mechanism exists anymore. The current install is a **manual, explicit** command:
> `npx wp-install-ai-hooks` (renamed from `wp-setup-ai-hooks`), which wires **two split PreToolUse
> hooks** (`wp-ai-rules-hook` + `wp-ai-guards-hook`) through the committed self-healing shim
> `.claude/webpieces/ai-hook.sh`. There is no postinstall and no global-dispatch. See
> `packages/tooling/ai-hook-rules/README.md` for the current flow. Kept only for the pnpm-v10 /
> shim / bin-symlink lessons at the bottom.

## Goal (of the abandoned attempt)
When a consumer runs `pnpm install` in their project, `@webpieces/ai-hook-rules` should:
1. Create `.webpieces/ai-hooks/claude-code-hook.js` bridge file
2. Optionally modify `.claude/settings.json` to wire up the hook
3. No warnings, no manual steps beyond `npx wp-setup-ai-hooks`

## Attempt 1: postinstall script pointing to compiled TypeScript
**What we did:** Added `"scripts": { "postinstall": "node src/bin/postinstall.js" }` to package.json with the logic in `src/bin/postinstall.ts`.

**Result: FAILED**
- In CI/workspace: `pnpm install` runs postinstall BEFORE build, so `src/bin/postinstall.js` doesn't exist (only `.ts`). Build fails.
- Error: `ENOENT: no such file or directory`

## Attempt 2: Plain JS shim in bin/ as postinstall
**What we did:** Created `bin/postinstall.js` (plain JS, not TypeScript) that checks if compiled `src/bin/postinstall.js` exists and delegates to it. `"scripts": { "postinstall": "node bin/postinstall.js" }`.

**Result: PARTIALLY WORKED but BLOCKED**
- Workspace: shim runs, compiled file doesn't exist, silently exits. No error. Good.
- Consumer: pnpm v10+ BLOCKS postinstall scripts from dependencies by default.
- User sees: `Ignored build scripts: @webpieces/ai-hook-rules@0.2.120. Run "pnpm approve-builds"`
- Bad UX — every consumer must run `pnpm approve-builds` or whitelist the package.

## Attempt 3: Two-PR approach (compile first, add postinstall later)
**What we did:** PR1 would compile `src/bin/postinstall.ts` and publish without postinstall. PR2 would add postinstall pointing to the now-published compiled JS.

**Result: NOT NEEDED** — we realized the shim pattern solves the workspace problem without two PRs.

## Attempt 4: bin entry pointing to compiled TypeScript
**What we did:** Removed postinstall. Added `"bin": { "wp-setup-ai-hooks": "./src/bin/postinstall.js" }` pointing directly to the compiled TypeScript output.

**Result: FAILED**
- In workspace: pnpm tries to create bin symlink during `pnpm install`, but `src/bin/postinstall.js` doesn't exist yet (only `.ts`).
- Warning: `Failed to create bin at .../wp-setup-ai-hooks. ENOENT: no such file or directory, chmod '.../src/bin/postinstall.js'`
- Same problem affects `@webpieces/code-rules` with `"bin": { "wp-validate-code": "./src/cli.js" }`

> **Clarification (retest — see Attempt 7):** This ENOENT is **WORKSPACE-ONLY**. It
> happens only in THIS source monorepo, where the package is symlinked to its source dir
> and the compiled `src/*.js` does not exist at `pnpm install` time (the build runs after
> install). **CLIENT projects are NOT affected:** they install the *published npm tarball*,
> which ships the compiled `src/cli.js` / `src/wp-ci.js` (the `files` field includes
> `src/**/*`), so the bin target exists, `chmod` succeeds, and there is no warning. With
> `#!/usr/bin/env node` as the first line of the `.ts` entry, tsc preserves the shebang into
> the compiled output, so the file is directly executable. So for the *manual-command* bins
> (no install-time need), pointing `bin` at the compiled `.js` is viable for consumers — the
> shim was only ever guarding the workspace pre-build window.

## Attempt 5: Plain JS shim as bin entry (SUPERSEDED — see CLAUDE.md "No bin shims")

> **⚠️ This was rolled back for all but one package.** The clarification directly above is the part that
> held up: the ENOENT is workspace-only, so the shim only ever guarded packages a `workspace:` sibling
> links from source. Fifteen of the seventeen shims guarded nothing — two of `nx-webpieces-rules`'
> `workspace:*` deps were declared but never imported — and were deleted in PR #585. `bin` now points at
> the compiled `.ts` entry everywhere except `code-rules`, which really is source-linked. The rule and
> its rationale live in **CLAUDE.md → "No bin shims — `bin` points at compiled TypeScript"**; this
> section is the history, not the instruction.
**What we did:** Same pattern as TypeScript's own `bin/tsc` → `lib/tsc.js`:
- `bin/wp-setup-ai-hooks.js` — plain JS file that always exists (not compiled from TS)
- `"bin": { "wp-setup-ai-hooks": "./bin/wp-setup-ai-hooks.js" }`
- The shim `require()`s the compiled `src/bin/postinstall.js` at runtime
- In workspace pre-build: file exists, symlink created, but if run it says "not built yet"
- In consumer from npm: both files exist, shim delegates to compiled TS

Same fix applied to `@webpieces/code-rules`:
- `bin/wp-validate-code.js` — plain JS shim
- `"bin": { "wp-validate-code": "./bin/wp-validate-code.js" }`

**Also fixed:**
- `@swc/core` upgraded from 1.5.7 → 1.15.30 (peer dep warning fix)
- `@swc/helpers` upgraded from 0.5.11 → 0.5.17 (peer dep warning fix)
- Added `"files": ["src/**/*", "bin/**/*"]` to code-rules package.json

**Status: CODE COMPLETE — published as v0.2.121**

**CI failure (exit 130) is NOT caused by our changes:**
- `nx affected --target=ci` hangs at 100% CPU in docker and in CI
- Even `nx --version` hangs in this docker environment
- The `pnpm install` step PASSES (no more postinstall/bin warnings)
- The failure is in the nx execution step, which is a pre-existing nx issue
- Need to investigate nx hanging separately

## Attempt 6: Back to postinstall + pnpm approve-builds (CURRENT)
**What we learned:** pnpm v10+ blocks ALL postinstall scripts from dependencies — even ones that just print. This is the industry standard. Prisma, sharp, esbuild all require `pnpm approve-builds`. The approval persists in `pnpm-workspace.yaml` so it's one-time per project.

**What we did:**
- Added back `"scripts": { "postinstall": "node bin/postinstall.js" }` to package.json
- `bin/postinstall.js` is a plain JS shim (workspace: silently exits, consumer: delegates to compiled TS)
- ALSO keep `"bin": { "wp-setup-ai-hooks": "./bin/wp-setup-ai-hooks.js" }` as manual fallback
- Both shims use `fs.existsSync()` instead of try/catch (eslint rules block try/catch in plain JS)

**Consumer experience:**
1. `pnpm install` → sees "Ignored build scripts: @webpieces/ai-hook-rules. Run pnpm approve-builds"
2. `pnpm approve-builds` → one-time approval, stored in pnpm-workspace.yaml
3. `pnpm install` again → postinstall runs, creates bridge file, prompts for settings.json
4. OR skip approve-builds and just run `npx wp-setup-ai-hooks` manually

**Also fixed in this attempt:**
- Removed `check_package_json_freshness()` from `scripts/build.sh` — false positives on non-dependency package.json changes (like bin entries) because it used file timestamps instead of content comparison

**Status: IMPLEMENTING**

## Attempt 7: De-shim the MANUAL-command bins only (keep the postinstall shims)
**Insight:** Attempt 5's shims were applied uniformly, but only bins that run at
*install time* (before any build) actually need a checked-in plain-JS shim. The
manual-command bins have no install-time catch-22 — they run only after a build (workspace)
or from a prebuilt package (consumer).

**What we did:**
- `@webpieces/code-rules` — dropped both shims. Added `#!/usr/bin/env node` to the top of
  `src/wp-ci.ts` and `src/cli.ts` (tsc preserves it), set
  `"bin": { "wp-ci": "./src/wp-ci.js", "wp-validate-code": "./src/cli.js" }`, deleted
  `bin/wp-ci.js`, `bin/wp-validate-code.js`, and the now-empty `bin/` build asset in
  project.json.

**Kept as shims (genuine install-time catch-22 — do NOT de-shim):**
- `ai-hook-rules/bin/postinstall.js` — wired to `postinstall`, runs during `pnpm install`
  before any build.
- `ai-hook-rules/bin/wp-setup-ai-hooks.js` — run for THIS project in a pre-build context;
  shares the same compiled `src/bin/postinstall.js`.
- `packages/rules/postinstall.js` — plain-JS install-time message; no TS behind it.

**Expectation / verification plan:**
- CLIENT projects (published version): clean — compiled `.js` ships in the tarball, so the
  bin resolves and runs. This is the intended win.
- THIS monorepo: a cosmetic `ENOENT chmod` warning may appear during `pnpm install`
  (workspace pre-build window; these bins aren't used at install). See the Attempt-4
  clarification above.
- **To confirm:** publish this branch, install the published version in a client, verify no
  ENOENT and that `wp-ci` / `wp-validate-code` execute.

**Status: SUPERSEDED BY ATTEMPT 8 — do not re-apply.**

## Attempt 8: Re-shim ALL bins (CURRENT)

**Why Attempt 7 was wrong:** it optimised for "the shim is only strictly *needed* at install
time" and accepted the workspace ENOENT as cosmetic. The cost turned out to be real. In THIS
monorepo `@webpieces/nx-webpieces-rules` depends on its siblings via `workspace:*`, so pnpm
links `pr-gate` and `code-rules` from their **source** dirs into
`packages/tooling/nx-webpieces-rules/node_modules/`, and chmods each `bin` target. With `bin`
pointing at `./src/**/*.js` that is **10 failed chmods, repeated on every install pass — ~40
`WARN Failed to create bin ... ENOENT` lines per `pnpm install`**. Those lines are
byte-for-byte indistinguishable from a genuine bin-link failure, so a REAL broken bin is
invisible. During the 0.4.499 upgrade an agent had to hand-verify that
`wp-review-upsert-pr` had linked, because the answer was buried in that wall of red.

**What we did:** restored the Attempt-5 shim pattern, this time uniformly:

- `pr-gate/bin/*.js` — 8 plain-JS shims; `bin` map now `./bin/<name>.js`;
  added `bin/**/*` to `files` and a `bin` asset to `project.json`.
- `code-rules/bin/*.js` — 2 shims (re-adding what Attempt 7 deleted); `files` already
  listed `bin/**/*`.
- `nx-webpieces-rules/bin/wp-design-visualize.js` — 1 shim. It emits no warning today (no
  workspace package depends on `nx-webpieces-rules`), but it is the same latent trap, and
  uniformity is what makes the invariant checkable.

The shim `require()`s the compiled entry and, if it is missing, prints
`package not built yet` and exits 1 — so an unbuilt workspace fails loudly instead of
half-running. `fs.existsSync`, no try/catch (the eslint rules block try/catch in plain JS).

**Regression guard:** `nx-webpieces-rules/src/lib/__tests__/bin-targets-exist.spec.ts` walks
every workspace `package.json` and fails if any `bin` target is missing on disk, or points
into `src/`. That test is what keeps Attempt 7 from being re-invented.

**Published tarball:** unchanged in substance — it still ships `src/**/*` compiled in place
(`main`, `exports` and every deep import are untouched), and now additionally ships
`bin/*.js`. The only difference for a consumer is one extra `require` hop from
`bin/wp-x.js` to `src/.../wp-x.js`. Verified by building to
`dist/packages/tooling/{pr-gate,code-rules}` and executing the dist shims.

**Status: DONE — zero `Failed to create bin` warnings on a clean `pnpm install`.**

## Key Lessons
1. `postinstall` scripts are blocked by pnpm v10+ — but this is the STANDARD pattern (prisma, sharp, esbuild do the same)
2. `pnpm approve-builds` persists in `pnpm-workspace.yaml` — one-time per project, not per install
3. `bin` entries pointing to compiled TS fail in workspaces — use plain JS shims that delegate
4. The shim must exist as a real `.js` file in the source tree, not generated by compilation
5. `build.sh` timestamp checks (`-nt`) are unreliable — pnpm doesn't rewrite lockfile when content unchanged
6. Apply the shim to **every** bin, not just install-time ones (Attempt 7 → 8). A "cosmetic"
   ENOENT warning is not cosmetic once there are forty of them: it is camouflage for the real
   failure the warning exists to report.
