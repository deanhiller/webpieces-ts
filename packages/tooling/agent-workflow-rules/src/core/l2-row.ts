/** Which tools a row covers. `B` Bash · `R` Read · `E` Write/Edit. */
export type L2Tool = 'B' | 'R' | 'E';

/** What L2 does with a row — the same action codebook every layer reports in (GUARD_MATRIX.md). */
export type L2ActionKind = 'allow' | 'exempt' | 'block' | 'fail-open';

/**
 * The TERMINAL fail-open row, and the one number in this table that is not from the 1-10 design.
 *
 * Everything in rows 6-10 needs the asynchronously refreshed cache, so the first call can have no
 * data. It is 11 rather than a renumbered 6 because row numbers are logged identity.
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

/** One observed situation in L2's generated use-case table. */
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

/** A use case that is not an L2 row exit, and therefore has no reason-to-row join. */
export const NO_ROW_EXIT = 'NO_ROW_EXIT (not an L2 row exit — another layer owns this state)';

/** One row of L2's first-match-wins decision table. */
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
        /** A required non-empty tuple: every row must document at least one observed use case. */
        readonly useCases: readonly [L2UseCase, ...L2UseCase[]],
    ) {}

    /** `B R E`, the doc's own spelling of the tool cell. */
    toolCell(): string {
        return this.tools.join(' ');
    }
}
