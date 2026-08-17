// ---------------------------------------------------------------------------
// GUARD_MATRIX.md's generation-status block, rendered from the one array that knows.
//
// THE BUG THIS FIXES IS IN THE FILE ITSELF. GUARD_MATRIX.md is the INDEX — the page that tells you
// which layer docs are generated and which are hand-written — and it was hand-written, so it went out
// of date about generation. It ended up contradicting itself inside ten lines: a blockquote asserting
// "L1's table ... generated" and "EVERY REMAINING LAYER FILE IS HAND-WRITTEN TODAY", directly above a
// table listing L2 as generated and byte-locked. Both were once true; L2 was converted and only one of
// the two places was updated.
//
// A doc that describes generation is exactly the doc that must be generated, because it is the one
// place a reader goes to find out whether to trust the others. So the STATUS is data here, the block
// between the markers is spliced from it, and a spec byte-locks the result — the same treatment
// guards/L0-tooling.md gets, and for the same reason: everything outside the markers stays
// hand-written prose that the splice preserves byte for byte.
//
// WHAT IS DELIBERATELY NOT GENERATED: the rest of GUARD_MATRIX.md — the action codebook, the launch
// guarantee, the two rules that constrain guard changes. Those are prose about DESIGN, not facts about
// the code, and a generator that owns them would be inventing a schema for essays.
// ---------------------------------------------------------------------------

/** Opening marker of the generated block, as it appears in GUARD_MATRIX.md. */
export const GUARD_INDEX_BEGIN = '<!-- BEGIN GENERATED — GuardIndexDoc.render() in ai-hook-rules/src/core/guard-index-doc.ts; run `pnpm guards:generate` -->';

/** Closing marker. Everything between the two is machine-owned; everything outside is prose. */
export const GUARD_INDEX_END = '<!-- END GENERATED — hand-written prose resumes here -->';

/** How much of a layer's doc is rendered from code. Data-only → a class, per CLAUDE.md. */
export class LayerGeneration {
    // eslint-disable-next-line @typescript-eslint/max-params -- the five cells of one status row
    constructor(
        /** `L0`, `L1`, … as the doc prints it. */
        readonly layer: string,
        /** The question this layer answers, for the layer table. */
        readonly goal: string,
        /** The `webpieces.config.json` key, or '' when the layer has none on purpose. */
        readonly configKey: string,
        /** Repo-relative path of the layer's doc. */
        readonly doc: string,
        /** The array the doc is rendered FROM, or '' when nothing is generated yet. */
        readonly source: string,
        /** The status cell, verbatim. */
        readonly status: string,
    ) {}

    /** The config-key cell — layers with no key say so, and say it is deliberate. */
    keyCell(): string {
        return this.configKey === '' ? '*(none — deliberate, see below)*' : `\`${this.configKey}\``;
    }

    sourceCell(): string {
        return this.source === '' ? '—' : `\`${this.source}\``;
    }
}

/**
 * THE FIVE LAYERS, and how much of each doc is machine-owned.
 *
 * Adding a layer, or converting one to generated, is an edit HERE and nowhere else — the index table,
 * the layer table and the one-command sentence all render from this array, so they cannot disagree
 * with each other the way the hand-written version did.
 */
export const LAYER_GENERATION: readonly LayerGeneration[] = [
    new LayerGeneration('L0', 'Is webpieces itself trustworthy right now?', '', 'guards/L0-tooling.md',
        'L0_FAULTS + L0_ALLOWLIST',
        '**PARTLY generated, byte-locked** — only the block between the `L0_DOC_BEGIN` / `L0_DOC_END` markers; every byte outside it is hand-written prose the splice preserves'),
    new LayerGeneration('L1', 'Is this call ours to judge, are the versions in sync, and is git run from the root?', '', 'guards/L1-location.md',
        'L1_ROWS',
        '**generated whole, byte-locked** — table, use cases and cures all render from the array the runner dispatches on'),
    new LayerGeneration('L2', 'May I work here, and is what I read current?', 'branch-state-guard', 'guards/L2-branch-state.md',
        'L2_ROWS',
        '**generated whole, byte-locked** — table, use cases and the "Not done" gaps all render from the rows'),
    new LayerGeneration('L3', 'Which dead branches and worktrees get reaped?', 'branch-creation-guard', 'guards/L3-branch-cleanup.md',
        '',
        '**hand-written** — not yet converted, so it CAN go out of date; the code is the authority'),
    new LayerGeneration('L4', 'Does every merge and PR go through the gated flow?', 'pr-lifecycle-guard', 'guards/L4-pr-lifecycle.md',
        '',
        '**hand-written** — not yet converted, so it CAN go out of date; the code is the authority'),
];

/**
 * The generated block of GUARD_MATRIX.md, and the splice that puts it there.
 *
 * Same class shape as L0ToolingDoc — renderer, extractor and splicer as one unit, driven by one spec.
 */
export class GuardIndexDoc {
    /** The whole generated block, WITHOUT the markers — those belong to the file, not the renderer. */
    render(): string {
        return [
            ...this.preamble(),
            ...this.statusTable(),
            ...this.layerTable(),
        ].join('\n');
    }

    /**
     * The generated text of `doc`, exactly as committed. Throws when a marker is missing or doubled —
     * a silently-unspliced doc is the drift this arrangement exists to end.
     */
    extract(doc: string): string {
        const opens = doc.split(GUARD_INDEX_BEGIN).length - 1;
        const closes = doc.split(GUARD_INDEX_END).length - 1;
        if (opens !== 1 || closes !== 1) {
            throw new Error(`GUARD_MATRIX.md must carry exactly one BEGIN/END marker pair, found ${String(opens)}/${String(closes)}`);
        }
        const afterBegin = doc.slice(doc.indexOf(GUARD_INDEX_BEGIN) + GUARD_INDEX_BEGIN.length);
        return afterBegin.slice(0, afterBegin.indexOf(GUARD_INDEX_END)).replace(/^\n/, '').replace(/\n$/, '');
    }

    /** `doc` with the generated block replaced by today's render. Preserves every byte outside it. */
    splice(doc: string): string {
        const head = doc.slice(0, doc.indexOf(GUARD_INDEX_BEGIN) + GUARD_INDEX_BEGIN.length);
        const tail = doc.slice(doc.indexOf(GUARD_INDEX_END));
        // extract() is called for its VALIDATION — one marker pair — before anything is rewritten.
        this.extract(doc);
        return `${head}\n${this.render()}\n${tail}`;
    }

    private preamble(): string[] {
        return [
            '> **GENERATED — do not hand-edit between the markers.** Rendered by `GuardIndexDoc.render()`',
            '> from `LAYER_GENERATION` (`ai-hook-rules/src/core/guard-index-doc.ts`); regenerate with',
            '> `pnpm guards:generate`. A spec byte-locks it.',
            '>',
            '> This block used to be prose, and it drifted about the one subject it exists to report: it',
            '> claimed every layer but L0 and L1 was hand-written, ten lines above a table listing L2 as',
            '> generated. The index that tells you which docs to trust is the last place that can afford',
            '> to be wrong, so it is data now.',
            '',
            '## Generation status',
            '',
        ];
    }

    private statusTable(): string[] {
        return [
            '| layer | source of truth | doc |',
            '|---|---|---|',
            ...LAYER_GENERATION.map((entry: LayerGeneration): string =>
                `| ${entry.layer} | ${entry.sourceCell()} | ${entry.status} |`),
            '',
            `One command regenerates every generated artifact: \`pnpm guards:generate\`. It rewrites the`,
            `${this.generatedWholeCount()} whole-file docs, SPLICES the marked blocks in L0's doc and in this file, writes the`,
            'AI-facing copy of the L2 matrix, and renders the POSIX-sh shim template.',
            '',
            'For a WHOLE-file layer the split is: **row data** lives in the array, **prose** lives as literal',
            'lines inside the renderer, there is no third place, and the byte-lock spec fails on any hand',
            'edit. **The two SPLICED files are the exception**: everything outside their marker pairs is',
            'hand-written prose the splice preserves byte for byte, and the spec deliberately permits you to',
            'edit it.',
            '',
            '**L1 and L2 differ in one way worth knowing.** L1 DISPATCHES from its rows — the runner takes the',
            'first matching row and switches on its `blockId`, so deleting a row deletes a block. L2\'s four',
            'guard classes each own their own ladder (they diverge in polarity, quantifier and empty-command',
            'handling, deliberately), so L2 joins to its rows by REASON instead: every decision-log line carries',
            '`row=<n>` derived from the reason the guard logged, plus the `cure=` that row prescribed, and a spec',
            'asserts the reason map is exhaustive against the guard sources.',
            '',
        ];
    }

    private layerTable(): string[] {
        return [
            '## The layers',
            '',
            '| layer | goal — the question it answers | config key | doc |',
            '|---|---|---|---|',
            ...LAYER_GENERATION.map((entry: LayerGeneration): string =>
                `| **${entry.layer}** | ${entry.goal} | ${entry.keyCell()} | [${entry.layer}](${entry.doc}) |`),
            '',
        ];
    }

    // Rendered into the prose so the sentence cannot claim a count the array disagrees with — the exact
    // failure mode this file is fixing ("One command regenerates all three" survived L2's conversion).
    private generatedWholeCount(): string {
        return String(LAYER_GENERATION.filter((entry: LayerGeneration): boolean =>
            entry.status.includes('generated whole')).length);
    }
}
