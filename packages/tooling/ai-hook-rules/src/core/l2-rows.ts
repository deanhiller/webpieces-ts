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
 * One row of the "L2 use cases" table: what you SEE, the state it puts you in, the verdict, the fix.
 *
 * THE POINT OF THIS CLASS is that a use case is added HERE, in code, beside the row it exercises — not
 * into a hand-written doc section that drifts. When a new situation comes up in a session, it becomes
 * one more `new L2UseCase(...)` on the row that judged it, `pnpm guards:generate` re-renders the doc,
 * and the byte-lock spec fails if anyone edits the rendered table instead.
 *
 * The four text fields are rendered VERBATIM. `reason` is the ENFORCEMENT half and is never rendered:
 * it is the exact `reason` string the guard logs for this case, so a spec can push it back through
 * `l2RowForReason` and assert it lands on the row this use case is filed under. That closes the loop
 * the L2 decision log opens — `row=` in the trail, this table on the page, one join between them.
 *
 * `reason` is REQUIRED, and a case that exercises something which is not an L2 row exit says so with
 * `NO_ROW_EXIT` rather than by omitting the argument. An optional field would make opting OUT of the
 * only real enforcement here the shortest thing to type and impossible to grep — the widening-by-absence
 * shape CLAUDE.md rejects. `grep NO_ROW_EXIT` now lists every unenforced case.
 */
export class L2UseCase {
    // eslint-disable-next-line @typescript-eslint/max-params -- four verbatim doc cells plus the reason behind them
    constructor(
        readonly num: number,
        readonly symptom: string,
        readonly state: string,
        readonly verdict: string,
        readonly fix: string,
        readonly reason: string,
    ) {}
}

/**
 * The `reason` for a use case that is NOT an L2 row exit, and so has nothing to join back to.
 *
 * The only legitimate case today is row 3: merge-in-progress is L4's state, and L2 exempts it without
 * logging a reason of its own. Named rather than absent, so "this case is not enforced" is a value in
 * the table you can grep for instead of a missing argument nobody notices.
 */
export const NO_ROW_EXIT = 'NO_ROW_EXIT (not an L2 row exit — another layer owns this state)';

/**
 * One row of L2's decision table.
 *
 * `cure` is rendered verbatim into the doc and is LITERAL by policy: L0's cure-reachability discipline
 * says a message pointing at documentation for its own remedy cannot be tested, and it caught a fault
 * prescribing a bin that had been renamed away. `—` is the only legal non-command cure, and only on a
 * row that allows.
 */
export class L2Row {
    // eslint-disable-next-line @typescript-eslint/max-params -- the five cells of one doc row plus its use cases
    constructor(
        readonly num: number,
        readonly tools: readonly L2Tool[],
        /** The `state` cell, verbatim. */
        readonly state: string,
        readonly action: L2Action,
        /** The `cure` cell, verbatim. `—` when the row allows. */
        readonly cure: string,
        /**
         * The observed situations this row judges. Rendered as the "L2 use cases" table.
         *
         * A NON-EMPTY tuple, and required: a row nobody has ever seen fire is either dead or
         * undocumented, and both are worth knowing. Expressing that in the TYPE rather than as a
         * runtime assertion is the JwtRoles pattern — the invariant is enforced at the moment the row
         * is written, which is the only moment that changes what somebody types.
         */
        readonly useCases: readonly [L2UseCase, ...L2UseCase[]],
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
    new L2Row(1, ['B', 'R', 'E'], 'on the **global allowlist** (inert command, or a universal cure such as reading/editing `webpieces.config.json`)', L2_ALLOW, '—', [
        new L2UseCase(1,
            'You are blocked by some other L2 row, and need to turn the policy off to get anything done',
            'any state — this row is ahead of every block',
            'ALLOW: reading and editing `webpieces.config.json` is never blocked, so the mode-OFF cure is always reachable',
            'Edit `webpieces.config.json` → `hookGuards` → `branch-state-guard` → `"mode": "OFF"`',
            'webpieces-config-read (escape hatch)'),
        new L2UseCase(2,
            'A Write to `webpieces.config.json` while on `main`, which row 5 would otherwise block',
            'on `main`, editing the one file that can disable the guard',
            'ALLOW: the hook adapter bypasses feature-branch-guard for this path before any guard runs',
            'None needed — the edit proceeds',
            'config-bypass (feature-branch-guard skipped)'),
    ]),
    new L2Row(2, ['B'], 'bare `git checkout main`, with no `git pull` chained into the same command', L2_BLOCK, '`pnpm wp-checkout-clean-main`', [
        new L2UseCase(3,
            '`git checkout main` after a merge, to start the next piece of work',
            'about to land on whatever local `main` you last had — 157 commits behind, in the incident',
            'BLOCK: decided from command TEXT alone, before the checkout, because the only `main` this could measure is the one it is about to leave',
            '`pnpm wp-checkout-clean-main` — checkout, pull, reap dead branches/worktrees, sweep orphan directories, in one command (hand-rolled, the pull must be in the SAME command as the checkout)',
            'bare checkout of main ('),
        new L2UseCase(4,
            'The same command inside a linked worktree, where `git checkout main` fatals anyway',
            'linked worktree — `main` is already checked out in the primary clone',
            'BLOCK, and the message prints the worktree form rather than a cure git would refuse',
            '`git fetch origin main`, then work off `origin/main`',
            'bare checkout of main ('),
    ]),
    new L2Row(3, ['B', 'R', 'E'], '**merge in progress** — L4 owns this state', L2_EXEMPT, 'finish the merge: `pnpm wp-finish-upsert-pr`', [
        new L2UseCase(5,
            'Reading and editing conflicted files during a 3-point merge, on a branch row 9 would block',
            'merge markers on disk — `pnpm wp-start-update` has run and not finished',
            'EXEMPT: everything is permitted, which is exactly what lets row 9 be strict',
            'Resolve the conflicts, then `pnpm wp-finish-upsert-pr`',
            NO_ROW_EXIT),
    ]),
    new L2Row(4, ['B'], 'on the **skip list** — it gets you OUT, or tells you where you are', L2_ALLOW, '—', [
        new L2UseCase(6,
            '`git status` / `gh pr view` while blocked, to work out where you are',
            'any state — orientation is never "working here"',
            'ALLOW: metadata tells you where you are without putting stale file CONTENT in context',
            'None needed',
            'not-a-content-read (cure/build/metadata)'),
        new L2UseCase(7,
            '`git stash` when `git checkout -b <new> origin/main` refuses because `origin/main` touched the same files you edited',
            'on a stale `main` or a merged branch, dirty tree, with an overlapping upstream change',
            'ALLOW: the cure for the row that blocked you must itself never be blocked — and this is the residual step that makes rows 6 and 8 safe to block on a dirty tree',
            'None needed — then re-run the checkout and `git stash pop`',
            'not-a-content-read (cure/build/metadata)'),
        new L2UseCase(8,
            '`pnpm wp-start-upsert-pr` on a branch whose fork point is broken',
            'row 9 state, running the tool row 9 prescribes',
            'ALLOW: every `wp-*` bin is on the skip list, so no row can block its own remedy',
            'None needed',
            'merged-branch recovery/inspection (allowlisted)'),
    ]),
    new L2Row(5, ['B', 'E'], 'on `main`', L2_BLOCK, '`git checkout -b <new> origin/main`', [
        new L2UseCase(9,
            'An Edit or Write to any tracked file while `git rev-parse --abbrev-ref HEAD` says `main`',
            'on `main`, any freshness',
            'BLOCK: decided by one `git rev-parse`, with NO cache read, so it fires on the first tool call of the session',
            '`git checkout -b <new> origin/main` — uncommitted work comes with you',
            'on-main'),
        new L2UseCase(10,
            'A Bash command that WRITES tracked files as a side effect — `npx expo install`, a formatter, codegen, `sed -i`, a `>` redirect',
            'on `main`, and the write is incidental to a command whose stated purpose is something else',
            'BLOCK: default-DENY on `main` plus row 4\'s skip list, so a command nobody thought to enumerate is caught by not being on the list — which is the only shape that could have caught this one',
            '`git checkout -b <new> origin/main` BEFORE running anything that may write',
            'on-main'),
        new L2UseCase(24,
            'A build or a test run on a `main` that is perfectly up to date',
            'on `main`, current — no staleness anywhere',
            'BLOCK: freshness is not the question. `main` is not a place to work even when current, and the cure is a new branch, not a pull',
            '`git checkout -b <new> origin/main`',
            'on-main'),
        new L2UseCase(16,
            'Read is blocked, so the session reaches for `cat`, `grep` and `ls` instead — and describes a CI workflow set missing a whole workflow that existed upstream',
            'the SIDE DOOR: same tree, different tool',
            'BLOCK. This case used to be judged by row 6 (a stale-content blocklist on the Bash side); row 5 now subsumes it, because being on `main` is already the finding and no enumeration of readers is needed. The log used to read "read-stale-guard handled", which is worse than no guard — it looks covered',
            '`git checkout -b <new> origin/main`',
            'on-main'),
        new L2UseCase(25,
            'The FIRST command of a session, on `main`, before any cache exists',
            'on `main`, cache absent — row 11 would fail open',
            'BLOCK anyway: row 5 is ABOVE the cache divider and reads only `git rev-parse`, so it is armed on call #1. This is the case the cache-gated version could never catch',
            '`git checkout -b <new> origin/main`',
            'on-main'),
    ]),
    new L2Row(L2_FAIL_OPEN_ROW, ['B', 'R', 'E'], '**the state could not be established** — branch undeterminable, no cache yet, the cache holds another branch, `origin/main` unknown, or the forge unreachable', L2_FAIL_OPEN, '— (nothing to fix; the refresher populates the cache for the next call)', [
        new L2UseCase(11,
            'The very first tool call of a session is allowed even on a badly stale `main`',
            'no cache — the refresher is fire-and-forget and populates it for the NEXT call',
            'ALLOW (fail-open), logged as `ALLOW_FAIL_OPEN` so abstentions stay countable',
            'None — the second call is judged normally',
            'no-sync-cache'),
        new L2UseCase(12,
            'Guards quietly stand down on a plane, or when `gh` is unauthenticated or rate-limited',
            'the forge could not be asked whether the PR is merged',
            'ALLOW (fail-open) logged as `no-forge` — distinct from "asked, and it is not merged", which used to look identical in the trail',
            'None — restore network/`gh auth` to re-arm the merged-branch policy',
            'no-forge'),
        new L2UseCase(14,
            'Mid-rebase, every guard abstains',
            'detached HEAD — there is no branch name to judge',
            'ALLOW (fail-open), logged LOUDLY when the branch is unresolvable rather than merely detached',
            'None — finish or abort the rebase',
            'branch-undeterminable'),
    ]),
    new L2Row(6, ['R'], 'on `main`, behind `origin/main`', L2_BLOCK, '`git pull origin main`, or `git checkout -b <new> origin/main`', [
        new L2UseCase(13,
            'The Read tool refuses a file on a stale `main` while you have UNCOMMITTED edits',
            'on `main`, behind `origin/main`, dirty tree',
            'BLOCK. This used to fail open, on the argument that the prescribed `git pull` is not a clean fast-forward when the tree is dirty. That was true of the MESSAGE, not the row: the cure cell always offered a second form, and it works dirty',
            '`git checkout -b <new> origin/main` — uncommitted changes come with you onto the new branch. If git refuses because `origin/main` touched the same files, `git stash` first (never blocked), then retry, then `git stash pop`',
            'on-stale-main'),
        new L2UseCase(15,
            'The Read tool refuses a file that exists, on a `main` 18 commits behind',
            'on `main`, behind `origin/main`, clean tree',
            'BLOCK: judged by live ancestry (`git merge-base --is-ancestor`), not hash equality, so a pull takes effect instantly',
            '`git pull origin main`, or `git checkout -b <new> origin/main`',
            'on-stale-main'),
    ]),
    new L2Row(7, ['R'], 'on `main`, current', L2_ALLOW, '—', [
        new L2UseCase(17,
            'Reading files on a `main` you just pulled',
            'on `main`, and `origin/main` is an ancestor of HEAD',
            'ALLOW: this is the ONE place a Read is judged differently from a Bash command, because a Read names exactly one file and can be evaluated precisely',
            'None needed',
            'local-main-contains-origin (up to date)'),
    ]),
    new L2Row(8, ['B', 'R', 'E'], 'on a branch whose PR is **already merged**', L2_BLOCK, '`git fetch origin main && git checkout -b <new> origin/main`', [
        new L2UseCase(18,
            'You keep working on the branch after its PR merged, and the next PR reopens code review already landed',
            'branch whose PR is merged — `merged` is monotonic, so the cached flag is trusted with no TTL',
            'BLOCK across all three tools',
            '`git fetch origin main && git checkout -b <new> origin/main`',
            'already-merged PR#'),
        new L2UseCase(26,
            'You have uncommitted edits on a branch whose PR just merged',
            'merged branch, dirty tree',
            'BLOCK. This used to fail open too, and that valve never had an argument behind it — row 8\'s cure carries uncommitted work onto the fresh branch, so nothing was ever trapped. It was drift from the documented design, which `read-stale-guard`\'s own class comment still described correctly',
            '`git fetch origin main && git checkout -b <new> origin/main` — your edits come with you',
            'already-merged PR#'),
        new L2UseCase(19,
            'A shell-only session sails through on a merged branch',
            'merged branch, Bash only — both FILE guards are file-scoped, so Bash reached neither',
            'BLOCK: `merged-branch-bash-guard` exists because `branchAlreadyMerged` was being computed and logged on that very path, then thrown away',
            '`git fetch origin main && git checkout -b <new> origin/main`',
            'already-merged PR#'),
    ]),
    new L2Row(9, ['B', 'R', 'E'], 'no fork point with `origin/main`, or `origin/main` moved and collided with your files', L2_BLOCK, '`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open', [
        new L2UseCase(20,
            'Your branch and `origin/main` share no merge base — usually a branch cut from a squashed-away tip',
            'no fork point',
            'BLOCK: nothing built on this branch can be reasoned about relative to main',
            '`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a PR is open',
            'no-fork-point'),
        new L2UseCase(21,
            '`origin/main` moved and changed the same files you edited',
            'main-moved collision',
            'BLOCK — and row 3 then exempts everything once the merge starts, which is what makes this safe',
            '`pnpm wp-start-update`, resolve, `pnpm wp-finish-upsert-pr`',
            'main-moved-conflict'),
    ]),
    new L2Row(10, ['B', 'R', 'E'], 'healthy feature branch', L2_ALLOW, '—', [
        new L2UseCase(22,
            'Ordinary work on a branch cut from a current `origin/main`',
            'healthy feature branch',
            'ALLOW — the state every other row exists to push you back into',
            'None needed',
            'clean-feature-branch'),
        new L2UseCase(23,
            '`stale-main-bash-guard` sees a feature branch and hands off',
            'not on `main` — state B belongs to `merged-branch-bash-guard`',
            'ALLOW: the same verdict about the same tree, logged by the guard that is not responsible for it',
            'None needed',
            'not-on-main (state B is another guard)'),
    ]),
];

/**
 * Every use case on every row, in row order, for the doc and for the exhaustiveness specs.
 *
 * Numbering is GLOBAL and is identity, exactly as the row numbers are: a use case is cited by number in
 * review and in the doc, so add new ones at the END of the highest number rather than renumbering to
 * keep a row's block contiguous.
 */
// webpieces-disable no-function-outside-class -- pure accessor over L2_ROWS above, in this data module
export function allL2UseCases(): readonly L2UseCase[] {
    return L2_ROWS.flatMap((row: L2Row): readonly L2UseCase[] => row.useCases);
}

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
    // `dirty-tree-on-main` and `dirty-merged-branch` used to live here. Both valves are deleted: rows
    // 6 and 8 now block on a dirty tree, because each row's cure carries uncommitted work with you.
    'no-forge': L2_FAIL_OPEN_ROW,
    // The config-edit bypass logged by the hook adapter before any guard runs — row 1, same universal
    // cure as the config READ above.
    'config-bypass (feature-branch-guard skipped)': 1,
};

/** Reasons the guards interpolate a value into. Matched by prefix, longest first. */
const PREFIX_REASON_ROWS: Record<string, number> = {
    'already-merged PR#': 8,
    'bare checkout of main (': 2,
    // `stale-main content read (` used to live here, mapping the Bash side of row 6. It is gone with
    // the guard exit that emitted it: on `main`, row 5 now blocks before any content-read scan runs,
    // so row 6 is what the table always said it was — the ROW-ONLY row.
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
    // EMPTY, and that is the goal state: every row in the table is a row the guards actually honour.
    //
    // It held three entries. Row 5's `B` half shipped (on `main` is now judged from the branch alone,
    // above the cache divider). Rows 6 and 8 held DIRTY-TREE valves, and both are now closed — each of
    // those rows cures with `git checkout -b <new> origin/main`, which carries uncommitted changes onto
    // the new branch, so a dirty tree never trapped anybody. The row 6 entry claimed the dirty argument
    // "has teeth" there because its cure is `git pull`; that was a fact about the MESSAGE, which printed
    // only the pull, and the fix was to print both cures rather than to suppress the block.
    //
    // Keep this array. An empty "Not done" is a claim worth making explicitly — the doc says so in as
    // many words — and the next divergence between a row and its code belongs here, not in prose.
];
