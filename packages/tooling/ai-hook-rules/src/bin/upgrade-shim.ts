#!/usr/bin/env node
import * as fs from 'fs';

import { renderShim, shimPath, findShimRoot } from './shim';
import { guaranteeRootPath, writeGuaranteeRoot } from './guarantee-root';
import { repairRegistrationAt, managedSurfaceDrift } from './hook-registration';
import { toError } from '../core/to-error';

// ---------------------------------------------------------------------------
// The `wp-upgrade-shim` entry point — the CURE for the managed-hook-surface self-guard (L0 fault S).
//
// WHAT IT REPAIRS, and why all three (2026-08-07). This used to write EXACTLY ONE FILE, ai-hook.sh,
// and touch nothing else. That was correct while the installed surface WAS one file. It is now three:
//
//   1. .claude/webpieces/ai-hook.sh          the guard shim, registered RELATIVE so each git tree runs
//                                            its own release, its own binary and its own pin
//   2. .claude/webpieces/guarantee-root.sh   the L-1 hook, registered ABSOLUTE, which refuses any `cd`
//                                            that would park the shell where the RELATIVE hooks cannot
//                                            launch — an unresolvable hook exits 127, and per the hooks
//                                            reference that is a NON-BLOCKING error, i.e. a SILENT
//                                            UNGUARDED ALLOW
//   3. the .claude/settings.json registration itself
//
// Leaving (2) and (3) out would have made the upgrade path silently useless: an upgrading consumer
// would take the new shim, KEEP the old two-absolute-hook registration, never receive guarantee-root.sh
// at all, and L-1 would never activate — with the drift check reporting nothing, because nothing
// validated settings.json. A cure that fixes one of three is worse than no cure, because it reports
// success. This bin is already the sanctioned cure named in fault S's message and already on the L0
// allowlist, so extending it keeps the existing self-healing path working end to end.
//
// Deliberately imports only ./shim, ./guarantee-root and ./hook-registration (fs + path) + toError,
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
        writeGuaranteeRoot(root);
        const rewired = repairRegistrationAt(root);
        reportRepairs(target, guaranteeRootPath(root), rewired);
        return verifyRepaired(root);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`${RED}🛑 @webpieces: could not write under ${root}: ${error.message}${RESET}`);
        return 1;
    }
}

/**
 * Say what was actually done, per managed thing. The old single line ("regenerated the managed shim")
 * would now be a lie by omission on the two most important repairs — and an agent reading a cure's
 * output is how it decides whether the cure worked.
 */
// webpieces-disable no-function-outside-class -- sibling of runUpgradeShim in this deliberately dependency-free bin module
function reportRepairs(shimFile: string, guaranteeFile: string, rewired: readonly string[]): void {
    console.log(`✅ @webpieces: regenerated the managed shim at ${shimFile} — tool calls are re-armed.`);
    console.log(`✅ @webpieces: regenerated the L-1 hook at ${guaranteeFile}.`);
    if (rewired.length === 0) {
        console.log('   .claude/settings.json hook registration already matches this release — no change.');
    } else {
        for (const file of rewired) {
            console.log(`✅ @webpieces: rewrote the hook registration in ${file} to the three-hook form`);
            console.log('   (L-1 absolute + the two guard hooks RELATIVE, so each git tree runs its own release).');
        }
    }
    console.log('  These files are generated + committed by webpieces; do not revert or hand-edit them.');
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
 * names this command as OPTION 1, the only option that repairs all three managed surfaces, so the
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
