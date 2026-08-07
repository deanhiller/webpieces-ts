/**
 * THE STREAM DIRECTORIES — `<state>/logs/<stream>/<sessionId>-<agentId|coordinator>-<hook>.log`.
 *
 * The stream is the DIRECTORY and the writer is the FILE. That split is the whole point: it puts the
 * LAYER in the path, so "show me every L1 decision this session" is one glob
 * (`logs/L1-location/<sid>-*`) instead of a question no glob could answer — every layer used to be
 * either a suffix on a flat name or, for L1, nothing at all.
 *
 * These live in ai-hook-rules beside LogStream, because all FOUR writers are here of this layout and
 * only two of them are TypeScript: the L-1 `guarantee-root.sh` and the L0 `ai-hook.sh` are POSIX sh
 * rendered from `bin/guarantee-root.ts` and `bin/shim-audit-log.ts`, and they must spell these
 * directories identically or the layers scatter. One constant, four consumers — the same reason
 * LogStream itself lives here.
 *
 * NOT in rules-config, and that is load-bearing rather than tidiness: the `wp-*` bins are SPAWNED as
 * processes with no tsconfig path mapping, so they resolve `@webpieces/rules-config` to the PUBLISHED
 * copy in node_modules — a release behind local source. A stream name defined there would render as
 * `undefined` inside a spawned `wp-upgrade-shim` while the in-process renderer used the real value,
 * and the two shims would differ by exactly the constant. Same-package means same source, always.
 *
 * Nesting by STREAM is not the nesting that was rejected. What `logs/` refused was nesting by
 * IDENTITY (`sessions/<id>/<agent>/…`), which breaks every cross-session question. A one-level
 * wildcard recovers the flat view here — `ls -t logs/[star]/<sid>-*` is still every stream in time
 * order, across every layer at once.
 */
export const LMINUS1_CD_STREAM = 'L-1-cd';
export const L0_SHIM_STREAM = 'L0-shim';
export const L1_LOCATION_STREAM = 'L1-location';
export const L2_DECISIONS_STREAM = 'L2-decisions';
export const CALLS_STREAM = 'calls';
export const ASYNC_REFRESH_STREAM = 'async-refresh';
export const REJECTIONS_STREAM = 'rejections';

/**
 * Every stream directory, for the sweeps and specs that must enumerate them rather than name one.
 * A new stream that is not added here is invisible to retention — which is why this is a list and not
 * a doc sentence.
 */
export const ALL_LOG_STREAMS: readonly string[] = [
    LMINUS1_CD_STREAM, L0_SHIM_STREAM, L1_LOCATION_STREAM, L2_DECISIONS_STREAM,
    CALLS_STREAM, ASYNC_REFRESH_STREAM, REJECTIONS_STREAM,
];
