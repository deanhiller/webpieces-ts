import { injectable, bindingScopeValues } from 'inversify';

/**
 * Builds the message stage ② (`wp-review-upsert-pr`) prints when a diff matched ZERO review checklists.
 *
 * ZERO IS A VALID, SUPPORTED STATE — it is NOT an error and NEVER blocks the flow. This exists only
 * because the previous behavior was to print nothing at all, which is indistinguishable from "the
 * checklist ran and passed". Silence is the bug; refusing would be a worse one.
 *
 * ORDER IS THE FEATURE. This block used to open with ~10 lines of "here is how to configure checklists"
 * and only reach the all-clear at the bottom, so a repo with none configured read as a repo with a
 * problem for the several seconds it took to scroll. The verdict now comes FIRST — headline, then the
 * all-clear — and the how-to sits below it, explicitly marked optional and for the human. The guidance is
 * genuinely useful the first time; it is just not the answer to "is anything wrong?".
 *
 * It also no longer names a command to run. Naming one here produced TWO "what to do next" instructions in
 * stage ②'s output — this one, and the real one below it that asks for review.json first — and an agent
 * reading top to bottom obeyed the first, skipping the review it was told to write. Exactly one next-step
 * instruction is emitted per stage now, and it is `ReviewReport`'s, not this class's.
 *
 * The two empty cases need different fixes, so they get different text:
 *   - NONE CONFIGURED  — the repo configured no checklists at all. Perfectly fine; mention that a human
 *                        MAY add checklist *.md docs if they want reviews, and move on.
 *   - NONE MATCHED     — checklists exist, but none of their patterns hit this diff. Also fine; report the
 *                        count so a human can judge whether that is expected.
 *
 * There is deliberately NO "misconfigured" case. Checklists live only in `pr-gate.checklists`, which
 * loadAndValidate validates — including that every doc and reviewer agent file exists — so a broken set
 * throws before any command reaches this class. The old tolerant manifest loader that returned [] for a
 * malformed doc (and thus enforced NOTHING while looking configured) is gone, and with it that failure mode.
 *
 * Pure string building, no I/O, so it is unit-testable without git or a repo.
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistNotice {
    /**
     * @param definedCount how many checklists `pr-gate.checklists` defines (0 = the repo configured none)
     */
    build(definedCount: number): string {
        return `${this.headline(definedCount)}\n${this.allClear()}\n${this.details(definedCount)}\n`;
    }

    // Line one: the verdict, in one line. A reader who only reads this far has the right answer.
    private headline(definedCount: number): string {
        if (definedCount === 0) {
            return '📋 Review checklists: NONE CONFIGURED (0 ran) — that is fine, this repo simply has none.';
        }
        return `📋 Review checklists: ${definedCount} defined in pr-gate.checklists, 0 matched this diff.`;
    }

    /**
     * The all-clear, immediately under the headline and BEFORE any explanation or how-to. Stated plainly so
     * neither the AI nor the human reads the notice as a gate that needs satisfying — and stated here, at
     * the top, so nobody has to read a config tutorial to find out that nothing is wrong.
     *
     * It deliberately names no command: the single next step is printed once, at the end of the stage.
     */
    private allClear(): string {
        return (
            '✅ Zero checklists is a perfectly valid state — this is INFORMATION, not a blocker, and\n' +
            '   nothing here needs fixing. Nothing is owed on the checklist front; keep going with the\n' +
            '   NEXT steps printed at the end of this command.\n'
        );
    }

    // Everything a reader may safely skip. Kept — it is what teaches a repo how to get reviews — but it
    // lives below the verdict, not in front of it.
    private details(definedCount: number): string {
        if (definedCount === 0) return this.howToConfigure();
        return this.whyNothingMatched();
    }

    private howToConfigure(): string {
        return (
            '   ── optional, for the human (skip this unless you WANT per-area reviews) ──────────────\n' +
            '   If you ever want reviews enforced on PRs that touch certain paths, add checklist *.md\n' +
            '   docs and list them in webpieces.config.json:\n' +
            '     "commands": { "pr-gate": { "checklists": [\n' +
            '       { "subagent": "db-migration-reviewer",\n' +
            '         "doc": ".claude/review/db-migrations.md",\n' +
            '         "patterns": ["**/migrations/**", "**/*.sql"] }\n' +
            '     ] } }\n' +
            '   `doc` is REPO-relative, `patterns` are path globs, and each entry needs its OWN reviewer\n' +
            '   subagent (a .claude/agents/<subagent>.md) — that is how independent review is enforced.'
        );
    }

    private whyNothingMatched(): string {
        return (
            '   ── why ──────────────────────────────────────────────────────────────────────────────\n' +
            '   None of their path patterns hit a changed file. Expected for changes outside those areas;\n' +
            '   if you thought one should have run, check its "patterns" against the changed-file list above.'
        );
    }
}
