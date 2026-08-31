import * as fs from 'fs';
import * as path from 'path';

import { CONFIG_FILENAME } from '@webpieces/rules-config';

import { L0_ALLOW_JS, MANIFEST_FILENAMES } from './l0-allowlist';
import { L0_IGNORED_TOOLS } from './l0-ignored-tools';

/**
 * THE DECISION — `isAllowed()`, the ONE question sh and JS both ask, and the two tool-shaped facts it
 * needs that no regex can express.
 *
 * Split out of ./l0-allowlist.ts (which was over the file-size limit) along the seam that was already
 * there: that module is the VOCABULARY — the named cure patterns and the one union built from them —
 * and this is what CONSULTS it. `shim.ts` re-exports both, so there is still ONE name to import L0 by
 * and every existing `from './shim'` import keeps working.
 *
 * The direction of the dependency is the reason for the split: this module imports the allowlist, the
 * allowlist imports nothing from here, and neither imports the rule engine — L0 must decide on a tree
 * too broken to load it.
 */
// The non-Bash half of the same list, kept here so sh and JS answer the identical question.
//
// `Read` is on the list because you must be able to READ to know how to fix — the original
// block-everything-but-the-cures version deadlocked a repo that also needed its config fixed. Note the
// asymmetry this creates and why it is accepted: under S/C/Y the bin IS running, so an allowed Read
// falls THROUGH to read-stale-guard and stale-main protection still holds; under D/X/K the bin is never
// executed, so there is nothing to fall through to and the Read is genuinely unguarded. Narrowing this
// entry to a path pattern is the fix for that, and is deliberately left for a follow-up.
export const READ_TOOLS: ReadonlySet<string> = new Set(['Read']);

/**
 * `isAllowed(call)` — THE L0 allowlist, with no fault parameter. See the block comment above.
 *
 * Returns the OUTCOME KIND, because the two are not the same thing:
 *   - 'pass'  → L0 has no objection; fall THROUGH so L1/L2 still judge this call (Read, config edit).
 *   - 'allow' → terminal; bypass everything, because a cure must stay reachable even when a downstream
 *               guard would block it.
 *   - null    → not on the list.
 *
 * `CONFIG_FILENAME` stays a basename match on purpose — one per tree; narrowing it is its own question.
 */
// webpieces-disable no-function-outside-class -- pure predicate over the exported allowlist data, in the dependency-free shim module (it must load on a corrupt tree, so it cannot depend on DI)
export function isAllowed(toolName: string, command: string, filePath: string): 'pass' | 'allow' | null {
    if (READ_TOOLS.has(toolName)) return 'pass';
    // Nothing to judge — see L0_IGNORED_TOOLS. `pass`, never `allow`: L0 declines to be terminal, so on
    // a healthy tree the call still falls through to whatever runs next.
    if (L0_IGNORED_TOOLS.has(toolName)) return 'pass';
    if (path.basename(filePath) === CONFIG_FILENAME) return 'pass';
    if (isRootManifest(filePath)) return 'pass';
    if (L0_ALLOW_JS.test(command.trim())) return 'allow';
    return null;
}

/**
 * Is `filePath` the `package.json` / `pnpm-workspace.yaml` at the ROOT OF A GOVERNED TREE — the only two
 * files the version cure ever edits?
 *
 * AS WIDE AS THE CURE AND NO WIDER. A basename match would put EVERY project, app and library
 * `package.json` on the L0 allowlist, and at L0 that is worse than it sounds: the sh half treats a hit
 * as TERMINAL (`exit 0`, the guard bin never runs), so each of those would be editable under fault
 * D/X/U/K with nothing downstream judging it. BUT IT MUST ADMIT EVERY TREE, not one — a worktree
 * agent's cure edits ITS OWN root manifest, and the shim's `$ROOT` names whichever tree supplied the
 * shim (governingShimRoot's straddle), so neither a basename nor a fixed root is the right test.
 *
 * The test is: its own directory must ALSO hold a `webpieces.config.json`. That file is TRACKED, so the
 * main clone has one and every linked worktree has its own — the same definition `runner.ts` uses
 * (`dirname(configPath)`), without knowing which tree you stand in. A project manifest deep under
 * `packages/` has no config beside it and is excluded. The sh twin is one `[ -f ... ]` test.
 */
// webpieces-disable no-function-outside-class -- pure fs+path predicate beside isAllowed in the dependency-free shim module
export function isRootManifest(filePath: string): boolean {
    if (!MANIFEST_FILENAMES.has(path.basename(filePath))) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return fs.existsSync(path.join(path.dirname(filePath), CONFIG_FILENAME));
    } catch (err: unknown) {
        //const error = toError(err); best-effort on a blocking path: unreadable is NOT a root manifest
        return false;
    }
}
