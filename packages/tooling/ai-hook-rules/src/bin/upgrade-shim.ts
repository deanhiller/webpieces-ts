#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

import { renderShim, shimPath, findShimRoot } from './shim';
import { repairRegistrationAt, managedSurfaceDrift, SettingsRepair, LEGACY_GUARANTEE_ROOT_MARKER } from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { toError } from '../core/to-error';

// ---------------------------------------------------------------------------
// The `wp-upgrade-shim` entry point — the CURE for the managed-hook-surface self-guard (L0 fault S).
//
// WHAT IT REPAIRS, and why all of them (2026-08-07, extended). This used to write EXACTLY ONE FILE,
// ai-hook.sh, and touch nothing else. That was correct while the installed surface WAS one file. It is
// now four (the name `wp-upgrade-shim` is older than the job and is NOT renamed — a rename with no
// functional change is a cost with no payer; the prose is what gets corrected):
//
//   1. .claude/webpieces/ai-hook.sh          the ONE guard shim, shared by every harness and registered
//                                            ABSOLUTE, so the MAIN tree governs every tree
//   2. the .claude/settings.json registration itself
//   3. the .codex/hooks.json registration — the SAME two hooks under Codex's own matchers and its own
//      $PWD anchor. Repaired only where it already EXISTS: arming a harness is the installer's decision,
//      this is the cure for one that has drifted
//   3b. the NEIGHBOUR hook commands in both of those files — the entries a CONSUMER repo registers
//      beside webpieces' own. A repo-RELATIVE entry path (`node ".claude/hooks/guard-deploy.mjs"`)
//      resolves against the hook process's cwd, so it dies the moment that cwd is not the repo root,
//      and per the hooks reference that non-zero exit is a NON-BLOCKING error — a SILENT UNGUARDED
//      ALLOW. Measured in a consumer repo (issue #852) silently disarming three security guards while
//      printing nothing but a `node:internal/modules/cjs/loader` fragment with no rule name. They are
//      anchored to the harness's own prefix, the same reversal webpieces made for its own hook. See
//      neighbour-hooks.ts
//   4. the .claude/settings.json `env` entry CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1, which pins the
//      Bash cwd to the project root — and, because settings `env` is inherited, pins it identically for
//      every subagent, so a verdict never depends on where an earlier `cd` left the shell. Claude-only:
//      Codex has no settings `env`, and its cwd is measured not to drift
//
// WHAT IT DELIBERATELY DOES *NOT* DO: sweep this tree's dangling `node_modules/.bin/wp-*` symlinks. That
// is the same class of defect as the retired-file removal below — an entry pointing at a missing file is
// worse than absence, because `ls node_modules/.bin` advertises a capability that only fails on execution
// — and it WOULD read naturally here. It is not here because the one implementation of that sweep lives in
// `@webpieces/rules-config` (`stale-bin-sweep.ts`), which this module may not import: the barrel pulls in
// inversify and the config loader, and a subpath import resolves against the INSTALLED rules-config, which
// is a release behind this source (see .claude/rules/published-vs-local-source.md) — so a spawned
// `wp-upgrade-shim` would die on module resolution, in the one command an L0-blocked session has left. A
// second copy of the sweep here would be a second spelling of it, which is worse again.
//
// It does not need to be here. The sweep rides the `wp-*` startup pass that regenerates
// `.webpieces/instruct-ai/*`, so ANY `wp-*` command heals the tree — including the `pnpm install` +
// `pnpm exec wp-upgrade-shim` sequence this bin's own advice ends with.
//
// It also DELETES the retired `.claude/webpieces/guarantee-root.sh` and any settings entry still naming
// it. That file was the L-1 hook, which existed only to guarantee the once-RELATIVE shim path resolved;
// an absolute path resolves from any cwd, so it has no job left. Removing the file without removing the
// entry (or vice versa) is the worst possible half-state — a registered hook pointing at a missing file
// exits 127, which per the hooks reference is a NON-BLOCKING error, i.e. a SILENT UNGUARDED ALLOW — so
// both happen here, file first.
//
// A cure that fixes some of them is worse than no cure, because it reports success. This bin is the
// sanctioned cure named in fault S's message and is on the L0 allowlist, so it must repair everything.
//
// Deliberately imports only ./shim and ./hook-registration (fs + path) + toError,
// exactly like install-entry: the whole job is to rewrite webpieces-managed files, which never needed
// the rule engine, and it must stay runnable on a tree too broken to load it.
// ---------------------------------------------------------------------------
const RED = '[31;1m';
const RESET = '[0m';

// Returns the process exit code (0 = ok). Kept as a function (not top-level code) so it is unit-testable
// without spawning node.
// webpieces-disable no-function-outside-class -- bin entry point: this module MUST load with only fs+path (see header), mirroring install-entry.ts. A DI-managed class would pull the container in and reintroduce the require-time crash this dependency-free path exists to survive.
export function runUpgradeShim(cwd: string): number {
    const root = findShimRoot(cwd);
    if (root === null) {
        console.error(`${RED}🛑 @webpieces: no committed .claude/webpieces/ai-hook.sh found to regenerate.${RESET}`);
        console.error('  Run this from a repo that installs @webpieces/ai-hook-rules, or run the installer (pnpm wp-install-ai-hooks).');
        return 1;
    }
    const target = shimPath(root);
    // webpieces-disable no-unmanaged-exceptions -- bin entry chokepoint: turn an fs error into an actionable line + non-zero exit rather than a raw node trace; there is no caller above a bin to handle it.
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        fs.writeFileSync(target, renderShim(), { mode: 0o755 });
        // writeFileSync's mode only applies on create; force it on overwrite too (matches writeShim).
        fs.chmodSync(target, 0o755);
        // ORDER MATTERS, and it is registration-FIRST. The reverse leaves a window in which a settings
        // entry still names a file that is gone — exit 127, which the hooks reference defines as a
        // NON-BLOCKING error, i.e. a SILENT UNGUARDED ALLOW. This way round the transient state is an
        // ORPHANED FILE that nothing references, which is inert. (An earlier draft of this function
        // argued file-first was safer; it is not. repairRegistration() also early-returns when the file
        // registers no guard bins, and the retired H1 command contains neither bin name, so a
        // guarantee-root-ONLY settings file would have lost the file and kept the entry.)
        const repairs = repairRegistrationAt(root);
        const removedLegacy = removeRetiredGuaranteeRoot(root);
        reportRepairs(target, removedLegacy, repairs);
        // ADVISORY ONLY, and deliberately after the ✅ lines: it never touches the exit code (see
        // reportTreeDivergence).
        reportTreeDivergence(root);
        return verifyRepaired(root);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`${RED}🛑 @webpieces: could not write under ${root}: ${error.message}${RESET}`);
        return 1;
    }
}

/**
 * Say what was actually done, per managed thing. The old single line ("regenerated the managed shim")
 * would now be a lie by omission on the three most important repairs — and an agent reading a cure's
 * output is how it decides whether the cure worked.
 *
 * Each settings file reports the repairs IT needed, from the flags recorded before the rewrite. Printing
 * "rewrote the hook registration" for a file whose hooks were already current and whose `env` entry was
 * the only thing missing would be the same class of dishonesty one level down.
 */
// webpieces-disable no-function-outside-class -- sibling of runUpgradeShim in this deliberately dependency-free bin module
/**
 * Delete the RETIRED L-1 hook file, returning whether there was one. Removal-only, one way, no writer.
 *
 * This runs AFTER repairRegistrationAt(), which strips the stale H1 ENTRY from settings.json. Removing
 * the entry first means the file is merely orphaned in between — inert, because nothing references it.
 * File-first would instead leave a registered hook pointing at a missing file, and per the hooks
 * reference a non-2 non-zero exit is a NON-BLOCKING error: every `cd` would go unjudged.
 */
// webpieces-disable no-function-outside-class -- module-scope like every other helper in this bin, which must load on a tree too broken to build a DI container
function removeRetiredGuaranteeRoot(root: string): boolean {
    // The path comes from LEGACY_GUARANTEE_ROOT_MARKER, never re-spelled here: a second literal is a
    // second spelling, and when the expiry in hook-registration.ts fires the documented removal would
    // miss this copy and the dead name would survive in a file nobody thought to grep.
    const legacy = path.join(root, LEGACY_GUARANTEE_ROOT_MARKER);
    if (!fs.existsSync(legacy)) return false;
    fs.rmSync(legacy, { force: true });
    return true;
}

// webpieces-disable no-function-outside-class -- module-scope like every other helper in this bin, which must load on a tree too broken to build a DI container
function reportRepairs(shimFile: string, removedLegacy: boolean, repairs: readonly SettingsRepair[]): void {
    console.log(`✅ @webpieces: regenerated the managed shim at ${shimFile} — tool calls are re-armed.`);
    if (removedLegacy) {
        console.log('✅ @webpieces: deleted the RETIRED L-1 hook .claude/webpieces/guarantee-root.sh.');
        console.log('   The guard hooks are ABSOLUTE now, so the launch guarantee it provided is structural.');
    }
    if (repairs.length === 0) {
        console.log('   .claude/settings.json (hook registration + managed env) already matches this release — no change.');
    }
    for (const repair of repairs) {
        if (repair.registration) {
            console.log(`✅ @webpieces: rewrote the hook registration in ${repair.settingsPath} to the two-hook form`);
            console.log('   (both guard hooks ABSOLUTE via $CLAUDE_PROJECT_DIR, so the MAIN tree governs every tree;');
            console.log('    any retired guarantee-root.sh entry was removed).');
        }
        for (const command of repair.anchoredNeighbours) {
            console.log(`✅ @webpieces: anchored a RELATIVE hook command in ${repair.settingsPath} so it resolves from any cwd`);
            console.log(`   now: ${command}`);
            console.log('   (a relative entry path resolves against the hook process cwd; off the repo root it fails to load, and');
            console.log('    per the hooks reference that non-zero exit is NON-BLOCKING — the guard silently stops guarding.)');
        }
        if (repair.env) {
            console.log(`✅ @webpieces: set env.${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE} in ${repair.settingsPath}`);
            console.log('   (pins the Bash cwd to the project root, so the guard hooks resolve identically for every subagent — for');
            console.log('   this session and, because settings env is inherited, for every subagent it spawns).');
        }
    }
    console.log('  These files are generated + committed by webpieces; do not revert or hand-edit them.');
}

/**
 * WAS THE REPAIRED TREE THE TREE THE HOOKS LAUNCH FROM — the second way this cure can report success
 * while changing nothing the session is actually governed by.
 *
 * H1 is registered ABSOLUTE, `sh "$CLAUDE_PROJECT_DIR/…"`, and `$CLAUDE_PROJECT_DIR` never moves off the
 * PRIMARY clone (the two-tree straddle recorded in shim.ts, and the whole reason H2/H3 are relative
 * while H1 is not). So repairing a LINKED WORKTREE leaves the running session still loading the
 * PRIMARY's files, the PRIMARY's binary and the PRIMARY's pin. Four green lines, and the block does not
 * lift. Nothing printed above is false — but the question the reader has ("will the block lift?") went
 * unanswered, which is the same failure this file's header exists to prevent, one level out.
 *
 * THE PREDICATE IS TREE DIVERGENCE, NOT "am I a subagent". There is no runtime subagent marker in the
 * hook environment to read, and divergence is the more accurate question anyway: a MAIN agent in a
 * linked worktree HAS this problem (a subagent test would miss it), and a SUBAGENT in the same tree does
 * NOT (a subagent test would cry wolf). Both paths are realpath'd before comparing — a worktree path can
 * arrive symlinked, and /tmp vs /private/tmp on darwin is a live case in this repo's own specs.
 *
 * SILENT when `$CLAUDE_PROJECT_DIR` is unset: a plain CLI run outside Claude Code has no second tree to
 * talk about. And ADVISORY always — it must never turn a verified repair into a failure, so it returns
 * nothing and `verifyRepaired()`'s contract (non-zero only when a surface in THIS tree still differs) is
 * untouched.
 */
// webpieces-disable no-function-outside-class -- sibling of runUpgradeShim in this deliberately dependency-free bin module
function reportTreeDivergence(root: string): void {
    const projectDir = process.env['CLAUDE_PROJECT_DIR'];
    if (projectDir === undefined || projectDir === '') return;
    if (sameTree(root, projectDir)) return;
    console.log('');
    console.log('⚠️  @webpieces: the tree just repaired is NOT the tree the hooks launch from.');
    console.log(`     repaired:            ${root}`);
    console.log(`     CLAUDE_PROJECT_DIR:  ${projectDir}`);
    console.log('   The hooks governing this session resolve through CLAUDE_PROJECT_DIR (H1 is registered');
    console.log('   absolute), so this repair has not changed what is currently enforcing — it made THIS');
    console.log('   tree correct for when its own branch is the one being judged, which is not wasted work.');
    console.log('   To change what is enforcing NOW, run the same repair in the primary tree, and install');
    console.log('   there too — the hooks execute the INSTALLED release, not this tree\'s source:');
    console.log(`     cd ${projectDir} && pnpm install && pnpm exec wp-upgrade-shim`);
    console.log('   Repaired in BOTH trees is the aligned end state, and running it twice is safe.');
}

/**
 * Do two paths name the same tree? realpath'd (symlinked worktrees, /tmp vs /private/tmp) and stripped
 * of a trailing separator before comparing. A path that cannot be realpath'd falls back to `resolve`,
 * so an absent CLAUDE_PROJECT_DIR directory reads as "different" rather than throwing inside a cure.
 */
// webpieces-disable no-function-outside-class -- sibling of runUpgradeShim in this deliberately dependency-free bin module
function sameTree(a: string, b: string): boolean {
    return canonicalTree(a) === canonicalTree(b);
}

// webpieces-disable no-function-outside-class -- sibling of runUpgradeShim in this deliberately dependency-free bin module
function canonicalTree(dir: string): string {
    // webpieces-disable no-unmanaged-exceptions -- realpath throws on a path that does not exist; the fallback IS the handling, and an advisory notice must never crash the cure it annotates.
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return path.resolve(fs.realpathSync(dir));
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: an unresolvable path simply compares as itself
        return path.resolve(dir);
    }
}

/**
 * DID THE CURE ACTUALLY CURE IT — asked of the same predicate the guard asks, not of our own writes.
 *
 * A cure that cannot fail loudly is worse than no cure. This bin used to print three ✅ lines and
 * return 0 the moment `writeFileSync` did not throw, which asserts only "the bytes we chose were
 * written", never "the surface the guard measures now agrees". Fault S blocks EVERY tool call, so the
 * one thing a blocked agent must be able to trust is whether the block will lift — and a success line
 * that is not backed by the guard's own check is exactly the false certainty that leaves it retrying a
 * cure that cannot work. So re-run `managedSurfaceDrift()`, the very function `enforceCommittedShim()`
 * calls, and return NON-ZERO naming whatever still differs.
 *
 * Measured against `root` (the tree we just repaired), not `governingShimRoot()` (the tree the running
 * binary came from). Those differ when the cure is run across trees, and the honest claim here is about
 * the files this invocation wrote.
 */
// webpieces-disable no-function-outside-class -- sibling of runUpgradeShim in this deliberately dependency-free bin module
function verifyRepaired(root: string): number {
    const stillDrifted = managedSurfaceDrift(root);
    if (stillDrifted.length === 0) return 0;
    console.error(`${RED}🛑 @webpieces: the repair ran but ${stillDrifted.length} managed surface(s) STILL differ: ${stillDrifted.join(', ')}.${RESET}`);
    console.error(`  The guard will keep blocking. This is a webpieces bug or an unwritable tree under ${root} - do not retry this command in a loop; report it with the list above.`);
    return 1;
}

/**
 * THE PROCESS ENTRY POINT — the thing whose absence made this whole bin a lie.
 *
 * Up to and including 0.4.588 this module ENDED at the closing brace above. `pnpm exec wp-upgrade-shim`
 * loaded it, defined two functions, and exited 0 having printed nothing and changed no file. Fault S
 * names this command as OPTION 1, the only option that repairs every managed surface, so the
 * guard's own "THIS IS NOT A DEADLOCK" promise was false: OPTION 2 repairs one of three, and OPTION 1
 * did nothing at all. Twenty-one unit tests missed it because every one of them called
 * `runUpgradeShim()` as a FUNCTION — the defect lived entirely in what the module does when SPAWNED.
 *
 * `runMain` from @webpieces/rules-config is the repo-wide wrapper and is deliberately NOT used here:
 * this bin must load with fs+path only (see the header) so it still runs on the broken tree it exists
 * to repair. `main()` is the sanctioned exit site instead, and `bin-process-entry.spec.ts` spawns
 * this file as a process so a future refactor cannot silently drop the launcher again.
 */
// webpieces-disable no-function-outside-class -- bin entry point in this deliberately dependency-free module; see header
export function main(): void {
    process.exit(runUpgradeShim(process.cwd()));
}

if (require.main === module) {
    main();
}
