import { ChecklistSource } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * Builds the message `wp-start-upsert-pr` prints when a diff matched ZERO review checklists.
 *
 * ZERO IS A VALID, SUPPORTED STATE — it is NOT an error and NEVER blocks the flow. This exists only
 * because the previous behavior was to print nothing at all, which is indistinguishable from "the
 * checklist ran and passed". Silence is the bug; refusing would be a worse one.
 *
 * The three empty cases need different fixes, so they get different text:
 *   - NONE CONFIGURED  — the repo configured no checklists at all. Perfectly fine; mention that a human
 *                        MAY add checklist *.md docs if they want reviews, and move on.
 *   - MISCONFIGURED    — checklists IS configured but broken. This one is worth shouting about:
 *                        the tolerant loader returns [] for it, so a broken doc silently enforces
 *                        NOTHING while looking configured.
 *   - NONE MATCHED     — checklists exist and are valid, but none of their patterns hit this diff.
 *                        Also fine; report the count so a human can judge whether that is expected.
 *
 * Pure string building, no I/O, so it is unit-testable without git or a repo.
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistNotice {
    /**
     * @param source          `prGate.checklists` — where this repo's checklists come from (empty = none)
     * @param manifestErrors  `ChecklistManifestService.validate()` output ([] when valid or unconfigured)
     * @param definedCount    how many checklists that source defines
     * @param finishCommand   the command to continue with, named in every branch
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    build(source: ChecklistSource, manifestErrors: readonly string[], definedCount: number, finishCommand: string): string {
        return `${this.reason(source, manifestErrors, definedCount)}\n${this.continueLine(finishCommand)}`;
    }

    private reason(source: ChecklistSource, manifestErrors: readonly string[], definedCount: number): string {
        if (manifestErrors.length > 0) return this.misconfigured(source.describe(), manifestErrors);
        if (source.isEmpty()) return this.noneConfigured();
        if (definedCount === 0) return this.emptyManifest(source.describe());
        return this.noneMatched(source.describe(), definedCount);
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

    private emptyManifest(sourceLabel: string): string {
        return (
            `📋 Review checklists: 0 defined — ${sourceLabel} is readable but lists no usable\n` +
            '   checklists (every entry needs a non-empty "subagent"). Fine to proceed; worth a look if\n' +
            '   you expected some to run.'
        );
    }

    // The one case that deserves volume: it LOOKS configured but enforces nothing.
    private misconfigured(sourceLabel: string, manifestErrors: readonly string[]): string {
        return (
            `⚠️  Review checklists: 0 ran because ${sourceLabel} is MISCONFIGURED — so this PR is getting NO\n` +
            '   checklist review even though this repo asked for one. Not fatal, but almost certainly not\n' +
            '   what you want:\n\n' +
            manifestErrors.map((e: string): string => `     • ${e}`).join('\n')
        );
    }

    private noneMatched(sourceLabel: string, definedCount: number): string {
        return (
            `📋 Review checklists: ${definedCount} defined in ${sourceLabel}, 0 matched this diff — none of their\n` +
            '   path patterns hit a changed file. Expected for changes outside those areas; if you thought\n' +
            '   one should have run, check its "patterns" against the changed-file list above.'
        );
    }
}
