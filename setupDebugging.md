# Setup Debugging: ai-hook-rules auto-install attempts

## Goal
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

## Attempt 5: Plain JS shim as bin entry (CURRENT)
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

## Key Lessons
1. `postinstall` scripts are blocked by pnpm v10+ — but this is the STANDARD pattern (prisma, sharp, esbuild do the same)
2. `pnpm approve-builds` persists in `pnpm-workspace.yaml` — one-time per project, not per install
3. `bin` entries pointing to compiled TS fail in workspaces — use plain JS shims that delegate
4. The shim must exist as a real `.js` file in the source tree, not generated by compilation
5. `build.sh` timestamp checks (`-nt`) are unreliable — pnpm doesn't rewrite lockfile when content unchanged
