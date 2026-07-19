import * as fs from 'fs';

import { renderShim, shimPath, findShimRoot } from './shim';
import { toError } from '../core/to-error';

// ---------------------------------------------------------------------------
// The `wp-upgrade-shim` entry point — the CURE for the committed-shim self-guard.
//
// The committed .claude/webpieces/ai-hook.sh is webpieces-MANAGED: generated from renderShim() and
// checked in only so the hook has a stable entry point when node_modules is absent. When it is reverted
// or hand-edited it no longer matches the installed template, and the shim's self-guard fails CLOSED
// (blocking every tool call) because stale escape-hatch logic must not run silently. That guard allows
// exactly ONE command through — this one — so the assistant can re-arm it without a deadlock.
//
// Deliberately imports only ./shim (fs + path) + toError, exactly like install-entry: the whole job is
// to rewrite the committed shim, which never needed the rule engine, and must stay runnable on a tree
// too broken to load it. We write renderShim() — the single source of truth — which the shipped template
// (templates/ai-hook.sh, byte-identical to renderShim() by a unit test) equals, so the self-guard, which
// compares the committed shim against that installed template, clears after this runs.
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
        console.log(`✅ @webpieces: regenerated the managed shim at ${target} — tool calls are re-armed.`);
        console.log('  This file is generated + committed by webpieces; do not revert or hand-edit it.');
        return 0;
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`${RED}🛑 @webpieces: could not write ${target}: ${error.message}${RESET}`);
        return 1;
    }
}
