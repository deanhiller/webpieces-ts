#!/usr/bin/env node
import * as fs from 'fs';

import { renderShim, shimPath, findShimRoot } from './shim';
import { guaranteeRootPath, writeGuaranteeRoot } from './guarantee-root';
import { repairRegistrationAt } from './hook-registration';
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
        return 0;
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
