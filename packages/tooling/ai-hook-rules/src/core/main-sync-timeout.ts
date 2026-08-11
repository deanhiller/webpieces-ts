import {
    loadAndValidate, WebpiecesRulesConfig, BranchStateGuardConfig, BRANCH_STATE_GUARD_KEY,
    DEFAULT_HANG_TIMEOUT_MINUTES,
} from '@webpieces/rules-config';

import { toError } from './to-error';
import { triggerMainSyncRefresh } from './main-sync-refresh';
import type { Rule } from './types';

// ---------------------------------------------------------------------------
// THE ONE `hangTimeoutMinutes`, and every caller that has to read it.
//
// There is ONE detached refresher writing ONE cache (.webpieces/main-sync-status.json), so there is one
// knob: `hookGuards.branch-state-guard.hangTimeoutMinutes`, which tunes the stale-lock reclaim window.
//
// It used to be declared FOUR times — once per branch-state guard class — and read four times, and
// three of those four values were structurally unable to take effect. Two things conspired:
// `triggerMainSyncRefresh` latches at most one spawn per hook process, and two callers ran BEFORE any
// guard's own call while passing the hardcoded default. So on the Bash path and the Read path (the two
// hottest) the default always won the latch and the configured value never reached a spawn.
//
// Collapsing four declarations into one only fixes that if EVERY caller reads the one. This module is
// where they do, which is also why it is a module rather than three helpers in runner.ts: the callers
// live in two files (the runner and the hook adapter) and a knob honoured in one of them is the bug
// again, one release later.
// ---------------------------------------------------------------------------

/**
 * The value on a branch-state ENTRY, or the default — for the four guard classes, which are handed
 * their own typed config and never see the whole file.
 *
 * The four used to spell this inline as `this.config.hangTimeoutMinutes ?? DEFAULT_HANG_TIMEOUT_MINUTES`,
 * which is a fourth copy of the resolution and exactly the shape that let the four DECLARATIONS drift
 * apart in the first place. One reader, one fallback.
 */
// webpieces-disable no-function-outside-class -- module-scope config accessor, matching the shape of the runner helpers it was extracted from
export function hangTimeoutOf(config: BranchStateGuardConfig): number {
    const configured = config.hangTimeoutMinutes;
    return typeof configured === 'number' ? configured : DEFAULT_HANG_TIMEOUT_MINUTES;
}

/** The configured value for a caller that has ALREADY loaded the whole config. */
// webpieces-disable no-function-outside-class -- module-scope config accessor, matching the shape of the runner helpers it was extracted from
export function branchStateHangTimeout(config: WebpiecesRulesConfig): number {
    const entry = config[BRANCH_STATE_GUARD_KEY];
    return entry === undefined ? DEFAULT_HANG_TIMEOUT_MINUTES : hangTimeoutOf(entry);
}

// Memoized per PROCESS, and a hook process handles exactly one tool call — so the adapter's two call
// sites cost at most one extra config parse between them, never one each.
let cachedHangTimeout: number | null = null;

/**
 * The configured value for a caller that has NOT loaded the config — the hook adapter's two pre-rule
 * refresh triggers (the webpieces.config.json edit bypass, and the Read fast path).
 *
 * Fails back to the default on an unloadable config: warming a cache must never throw on the tool path.
 */
// webpieces-disable no-function-outside-class -- module-scope config accessor, matching the shape of the runner helpers it was extracted from
export function branchStateHangTimeoutFor(cwd: string): number {
    if (cachedHangTimeout !== null) return cachedHangTimeout;
    let value = DEFAULT_HANG_TIMEOUT_MINUTES;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a cache-warming knob must never throw on the tool path
    try {
        value = branchStateHangTimeout(loadAndValidate(cwd).rulesConfig);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
    cachedHangTimeout = value;
    return value;
}

/** Test-only: clears the per-process memo above. */
// webpieces-disable no-function-outside-class -- module-scope test hook beside the memo it clears
export function resetHangTimeoutCacheForTest(): void {
    cachedHangTimeout = null;
}

/**
 * Fire-and-forget the detached refresher when the branch-state policy is loaded and active, so the
 * cache stays fresh as the AI works. The guard rules themselves also trigger it; this covers the Bash
 * path so the cache is warm on every command.
 *
 * Keyed on `feature-branch-guard` — the rule NAME, not the config key. Any of the four branch-state
 * classes would do (they share one entry, so they are on or off together); this one is asked because it
 * is the class whose cache freshness matters on the very next Write.
 */
// webpieces-disable no-function-outside-class -- module-scope refresh trigger, matching the shape of the runner helpers it was extracted from
export function maybeRefreshMainSync(rules: readonly Rule[], workspaceRoot: string, hangTimeoutMinutes: number): void {
    const guard = rules.find((r: Rule): boolean => r.name === 'feature-branch-guard');
    if (guard && guard.shouldRun()) {
        triggerMainSyncRefresh(workspaceRoot, hangTimeoutMinutes);
    }
}
