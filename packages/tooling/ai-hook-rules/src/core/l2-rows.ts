// ---------------------------------------------------------------------------
// L2 — the BRANCH-STATE layer, as data.
//
// L2 answers one question: *may I work here, and is what I read current?* Drawn as a decision matrix
// that is TEN ordered rows plus one terminal fail-open row, first match wins.
//
// This module holds those rows, l2-doc.ts renders them into guards/L2-branch-state.md, and a unit test
// (l2-matrix.spec.ts) locks that file byte-identical to the renderer — the same mechanism that already
// makes L0's fault table and L1's location table undriftable. Before this existed the L2 doc was 100%
// hand-written and said so: *"Until that lands this text is hand-written and can drift."*
//
// ## HOW L2 JOINS TO THE ROWS TODAY — read this before assuming it works like L1
//
// L1 DISPATCHES from its array: `runner.l1LocationBlock` takes the first matching row and switches on
// its `blockId`, so deleting a row deletes a block. L2 does NOT, and pretending otherwise would be the
// drift this table exists to remove. The four L2 guard classes each own their own ladder, and those
// ladders diverge on purpose (guards/L2-branch-state.md, "Deliberate divergence": the two Bash guards
// differ in polarity, quantifier and empty-command handling all at once, so no single parameterised
// function serves both). Unifying them is where a wrong edit turns an allow into a session-wedging
// block, so it is deliberately not attempted here.
//
// What L2 does instead is a REASON→ROW join. Every exit of every L2 guard already carries a stable
// reason string into the decision log; `L2_ROW_FOR_REASON` maps each of those to the row it is an
// instance of, the guards stamp that number as `row=`, and l2-matrix.spec.ts asserts the map is
// EXHAUSTIVE against the guard sources — a new reason with no row fails the build. So `row=8` in
// `.webpieces/logs/L2-decisions` opens guards/L2-branch-state.md at row 8 and reads the state, the cure
// and the tools that row covers, exactly as `row=5` already does for L1.
//
// The rows the guards cannot yet honour are named in the doc's "Not done" section rather than quietly
// rendered as if they were live. That section is generated from NOT_DONE below, so it cannot rot.
//
// This module is deliberately import-free at runtime, so `pnpm guards:generate` can load it without the
// package's transitive dependencies.
// ---------------------------------------------------------------------------

/** Which tools a row covers. `B` Bash · `R` Read · `E` Write/Edit. */
export type L2Tool = 'B' | 'R' | 'E';

/** What L2 does with a row — the same action codebook every layer reports in (GUARD_MATRIX.md). */
export type L2ActionKind = 'allow' | 'exempt' | 'block' | 'fail-open';

/**
 * The TERMINAL fail-open row, and the one number in this table that is not from the 1-10 design.
 *
 * Everything in rows 6-10 needs the main-sync cache, and the cache is written by a fire-and-forget
 * refresher that populates it for the NEXT call — so the first tool call of every session has none.
 * "Stop here and ALLOW" was written as a DIVIDER in the design table, i.e. as prose between two blocks
 * of rows. Prose cannot be stamped into a log line, and this is the single most frequently taken exit
 * in the whole layer (every session's first call, every unreadable branch, every unreachable forge), so
 * it is a row with a number like any other.
 *
 * It is 11 rather than 6-with-a-renumber because row numbers are IDENTITY here: they are printed in the
 * doc and logged as `row=`, so shifting 6-10 down would silently re-point every reference. The doc
 * prints it in its true position, between rows 5 and 6, with its number shown — same treatment L1 gives
 * row 8, which is printed third and numbered 8.
 */
export const L2_FAIL_OPEN_ROW = 11;

/** The `act` cell: the doc's literal label, plus the machine-readable kind behind it. */
export class L2Action {
    constructor(readonly label: string, readonly kind: L2ActionKind) {}
}

export const L2_ALLOW = new L2Action('1 allow', 'allow');
export const L2_EXEMPT = new L2Action('2 exempt', 'exempt');
export const L2_BLOCK = new L2Action('4 block', 'block');
export const L2_FAIL_OPEN = new L2Action('1 allow (fail-open)', 'fail-open');

/**
 * One row of L2's decision table.
 *
 * `cure` is rendered verbatim into the doc and is LITERAL by policy: L0's cure-reachability discipline
 * says a message pointing at documentation for its own remedy cannot be tested, and it caught a fault
 * prescribing a bin that had been renamed away. `—` is the only legal non-command cure, and only on a
 * row that allows.
 */
export class L2Row {
    // eslint-disable-next-line @typescript-eslint/max-params -- the five cells of one doc row
    constructor(
        readonly num: number,
        readonly tools: readonly L2Tool[],
        /** The `state` cell, verbatim. */
        readonly state: string,
        readonly action: L2Action,
        /** The `cure` cell, verbatim. `—` when the row allows. */
        readonly cure: string,
    ) {}

    /** `B R E`, the doc's own spelling of the tool cell. */
    toolCell(): string {
        return this.tools.join(' ');
    }
}

/**
 * THE ELEVEN L2 ROWS, in first-match-wins order.
 *
 * Rows 1-5 need NO cache and fire on call #1: rows 1, 2 and 4 are text matches, row 3 is a marker-file
 * scan, row 5 is one `git rev-parse`. Row 11 is the cache divider. Rows 6-10 all read the cache.
 *
 * THE ORDER OF ROW 5 IS THE MOST LOAD-BEARING THING IN THIS TABLE. Put "on main" BELOW the divider and
 * writes on `main` are permitted for the whole first call of every session — and permanently in a
 * multi-worktree repo, where another tree may hold the cache lock indefinitely.
 *
 * `B` tracks `E` everywhere; `R` is judged separately in exactly ONE place, rows 6/7 on `main`. A Read
 * names exactly one file so the guard can evaluate it precisely; a Bash command is opaque and gets the
 * conservative answer. Reading a CURRENT `main` is fine — the problem is that `main` is almost always
 * behind.
 */
export const L2_ROWS: readonly L2Row[] = [
    new L2Row(1, ['B', 'R', 'E'], 'on the **global allowlist** (inert command, or a universal cure such as reading/editing `webpieces.config.json`)', L2_ALLOW, '—'),
    new L2Row(2, ['B'], 'bare `git checkout main`, with no `git pull` chained into the same command', L2_BLOCK, '`git checkout main && git pull origin main`'),
    new L2Row(3, ['B', 'R', 'E'], '**merge in progress** — L4 owns this state', L2_EXEMPT, 'finish the merge: `pnpm wp-finish-upsert-pr`'),
    new L2Row(4, ['B'], 'on the **skip list** — it gets you OUT, or tells you where you are', L2_ALLOW, '—'),
    new L2Row(5, ['B', 'E'], 'on `main`', L2_BLOCK, '`git checkout -b <new> origin/main`'),
    new L2Row(L2_FAIL_OPEN_ROW, ['B', 'R', 'E'], '**the state could not be established** — branch undeterminable, no cache yet, the cache holds another branch, `origin/main` unknown, the forge unreachable, or a dirty tree whose cure is not a clean fast-forward', L2_FAIL_OPEN, '— (nothing to fix; the refresher populates the cache for the next call)'),
    new L2Row(6, ['R'], 'on `main`, behind `origin/main`', L2_BLOCK, '`git pull origin main`, or `git checkout -b <new> origin/main`'),
    new L2Row(7, ['R'], 'on `main`, current', L2_ALLOW, '—'),
    new L2Row(8, ['B', 'R', 'E'], 'on a branch whose PR is **already merged**', L2_BLOCK, '`git fetch origin main && git checkout -b <new> origin/main`'),
    new L2Row(9, ['B', 'R', 'E'], 'no fork point with `origin/main`, or `origin/main` moved and collided with your files', L2_BLOCK, '`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open'),
    new L2Row(10, ['B', 'R', 'E'], 'healthy feature branch', L2_ALLOW, '—'),
];

/**
 * REASON → ROW. The join between what a guard actually logged and the row it is an instance of.
 *
 * Keys are the exact `reason` strings the four L2 guards pass to their decision log. Two of them are
 * PREFIXES because the guard interpolates a PR number or a matched segment into the reason
 * (`already-merged PR#123`); those are matched by `l2RowForReason` on prefix, which is why they end in
 * a space or a `(`.
 *
 * l2-matrix.spec.ts reads the four guard sources and asserts every reason literal in them resolves
 * here, so a new exit with no row fails the build rather than logging `row=-` forever.
 */
const EXACT_REASON_ROWS: Record<string, number> = {
    // Row 1 — the universal cure that must stay reachable from inside any block.
    'webpieces-config-read (escape hatch)': 1,
    // Row 2 — the preventive half, decided from command TEXT before any cache is read.
    // (prefix, see PREFIX_REASON_ROWS)
    // Row 4 — the skip list, in its two live spellings.
    'merged-branch recovery/inspection (allowlisted)': 4,
    'not-a-content-read (cure/build/metadata)': 4,
    // Row 5 — never work on main.
    'on-main': 5,
    // Row 6/7 — the ONE place a Read is judged differently from a Bash command.
    'on-stale-main': 6,
    'local-main-contains-origin (up to date)': 7,
    // Row 9 — the two unhealthy-fork states.
    'no-fork-point': 9,
    'main-moved-conflict': 9,
    // Row 10 — healthy, and the state-B guard's "this is not my state" hand-off, which is the same
    // verdict about the same tree.
    'clean-feature-branch': 10,
    'not-on-main (state B is another guard)': 10,
    // Row 11 — every "could not establish", including the two dirty-tree valves the code still opens
    // (see NOT_DONE) and the unreachable forge.
    'branch-undeterminable': L2_FAIL_OPEN_ROW,
    'no-sync-cache': L2_FAIL_OPEN_ROW,
    'stale-cross-branch-cache': L2_FAIL_OPEN_ROW,
    'origin-main-unknown': L2_FAIL_OPEN_ROW,
    'dirty-tree-on-main': L2_FAIL_OPEN_ROW,
    'dirty-merged-branch': L2_FAIL_OPEN_ROW,
    'no-forge': L2_FAIL_OPEN_ROW,
    // The config-edit bypass logged by the hook adapter before any guard runs — row 1, same universal
    // cure as the config READ above.
    'config-bypass (feature-branch-guard skipped)': 1,
};

/** Reasons the guards interpolate a value into. Matched by prefix, longest first. */
const PREFIX_REASON_ROWS: Record<string, number> = {
    'already-merged PR#': 8,
    'bare checkout of main (': 2,
    'stale-main content read (': 6,
};

/**
 * The row a logged reason belongs to, or null when nothing claims it.
 *
 * Null rather than a default row: a reason with no row is a HOLE in the table, and defaulting it to
 * "fail-open" would hide exactly the drift the exhaustiveness spec exists to catch. The guards render
 * null as `row=-`, so an unmapped reason is visible in the log too, not only in CI.
 */
// webpieces-disable no-function-outside-class -- the matcher over the two tables above, beside them in this data module
export function l2RowForReason(reason: string): number | null {
    const exact = EXACT_REASON_ROWS[reason];
    if (exact !== undefined) return exact;
    for (const prefix of Object.keys(PREFIX_REASON_ROWS)) {
        if (reason.startsWith(prefix)) return PREFIX_REASON_ROWS[prefix];
    }
    return null;
}

/** Every reason string this table claims, for the exhaustiveness spec. */
// webpieces-disable no-function-outside-class -- pure accessor over the two tables above
export function l2MappedReasons(): readonly string[] {
    return [...Object.keys(EXACT_REASON_ROWS), ...Object.keys(PREFIX_REASON_ROWS)];
}

/** One documented gap between a row and what the guards actually do today. Data-only. */
export class L2NotDone {
    constructor(readonly row: number, readonly gap: string, readonly why: string) {}
}

/**
 * WHERE THE TABLE AND THE CODE DISAGREE, stated rather than papered over.
 *
 * The L1 precedent is `## Not done — \`o\` is not exempt yet`: a row the runner cannot reach, named in
 * the generated doc with the reason it has not shipped. The same treatment applies here, and it is what
 * makes it safe to publish a table the guards do not yet dispatch from — a reader is told exactly which
 * rows describe intent rather than behaviour, and the log's `row=` stamps land on row 11 for every one
 * of these, so the trail never claims the strict row fired.
 */
export const NOT_DONE: readonly L2NotDone[] = [
    new L2NotDone(5,
        'Row 5 blocks `B` as well as `E` on `main`. Only `E` is blocked today: `feature-branch-guard` blocks the write, while `stale-main-bash-guard` blocks only CONTENT-READING Bash, and only once the cache proves `main` is behind.',
        'Bash on a CURRENT `main` is harmless, and the strict form needs the skip list (row 4) to be complete first — a `B`-on-main block with an incomplete skip list wedges the session on its own cure.'),
    new L2NotDone(8,
        'Row 8 blocks reads on a merged branch even when the tree is DIRTY. The code opens a dirty valve and fails open (`dirty-merged-branch`, logged at row 11).',
        'The row is the ORIGINAL documented design — `git checkout -b <new> origin/main` carries uncommitted changes onto the fresh branch, so nothing is trapped — and `read-stale-guard`\'s own class comment still states it. The code drifted, and closing the valve is a behaviour change that belongs in its own PR with its own evidence, not in a config collapse.'),
    new L2NotDone(6,
        'Row 6 blocks reads on a stale `main` even when the tree is DIRTY. The code opens a dirty valve (`dirty-tree-on-main`, logged at row 11).',
        'This is the one place the dirty argument has teeth: the cure is `git pull`, which genuinely is not a clean fast-forward on a dirty tree. `git stash` is on the skip list and clears it, so the strict form is reachable — but it is the same behaviour change, and the same separate PR.'),
];
