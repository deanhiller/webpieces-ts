import { injectable, bindingScopeValues } from 'inversify';

/**
 * Builds the message `wp-start-upsert-pr` prints when a diff matched ZERO review checklists.
 *
 * ZERO IS A VALID, SUPPORTED STATE — it is NOT an error and NEVER blocks the flow. This exists only
 * because the previous behavior was to print nothing at all, which is indistinguishable from "the
 * checklist ran and passed". Silence is the bug; refusing would be a worse one.
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
     * @param definedCount   how many checklists `pr-gate.checklists` defines (0 = the repo configured none)
     * @param finishCommand  the command to continue with, named in every branch
     */
    build(definedCount: number, finishCommand: string): string {
        return `${this.reason(definedCount)}\n${this.continueLine(finishCommand)}`;
    }

    private reason(definedCount: number): string {
        if (definedCount === 0) return this.noneConfigured();
        return this.noneMatched(definedCount);
    }

    // Every branch ends here: 0 checklists is OK, keep going. Stated plainly so neither the AI nor the
    // human reads the notice as a gate that needs satisfying before finishing.
    private continueLine(finishCommand: string): string {
        return (
            `\n✅ Zero checklists is a perfectly valid state — this is INFORMATION, not a blocker, and\n` +
            `   nothing here needs fixing before you continue. Carry on and run:  pnpm ${finishCommand}\n`
        );
    }

    private noneConfigured(): string {
        return (
            '📋 Review checklists: NONE CONFIGURED (0 ran) — that is fine, this repo simply has none.\n' +
            '\n' +
            '   FYI for the human: if you ever want per-area reviews enforced on PRs that touch certain\n' +
            '   paths, add checklist *.md docs and list them in webpieces.config.json:\n' +
            '     "commands": { "pr-gate": { "checklists": [\n' +
            '       { "subagent": "db-migration-reviewer",\n' +
            '         "doc": ".claude/review/db-migrations.md",\n' +
            '         "patterns": ["**/migrations/**", "**/*.sql"] }\n' +
            '     ] } }\n' +
            '   `doc` is REPO-relative, `patterns` are path globs, and each entry needs its OWN reviewer\n' +
            '   subagent (a .claude/agents/<subagent>.md) — that is how independent review is enforced.'
        );
    }

    private noneMatched(definedCount: number): string {
        return (
            `📋 Review checklists: ${definedCount} defined in pr-gate.checklists, 0 matched this diff — none of their\n` +
            '   path patterns hit a changed file. Expected for changes outside those areas; if you thought\n' +
            '   one should have run, check its "patterns" against the changed-file list above.'
        );
    }
}
