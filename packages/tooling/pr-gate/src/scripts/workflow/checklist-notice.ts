import { injectable, bindingScopeValues } from 'inversify';

/**
 * Builds the message `wp-start-upsert-pr` prints when a diff matched ZERO review checklists.
 *
 * ZERO IS A VALID, SUPPORTED STATE — it is NOT an error and NEVER blocks the flow. This exists only
 * because the previous behavior was to print nothing at all, which is indistinguishable from "the
 * checklist ran and passed". Silence is the bug; refusing would be a worse one.
 *
 * The three empty cases need different fixes, so they get different text:
 *   - NONE CONFIGURED  — the repo has no checklists.doc. Perfectly fine; mention that a human MAY add
 *                        checklist *.md docs if they want reviews, and move on.
 *   - MISCONFIGURED    — checklists.doc is set but missing/malformed. This one is worth shouting about:
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
     * @param docRel          `prGate.checklistDoc` ('' when the repo configured none)
     * @param manifestErrors  `ChecklistManifestService.validate()` output ([] when valid or unconfigured)
     * @param definedCount    how many checklists the manifest defines
     * @param finishCommand   the command to continue with, named in every branch
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    build(docRel: string, manifestErrors: readonly string[], definedCount: number, finishCommand: string): string {
        return `${this.reason(docRel, manifestErrors, definedCount)}\n${this.continueLine(finishCommand)}`;
    }

    private reason(docRel: string, manifestErrors: readonly string[], definedCount: number): string {
        if (manifestErrors.length > 0) return this.misconfigured(docRel, manifestErrors);
        if (docRel.trim() === '') return this.noneConfigured();
        if (definedCount === 0) return this.emptyManifest(docRel);
        return this.noneMatched(docRel, definedCount);
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
            '   paths, add checklist *.md docs and point webpieces.config.json at an index doc:\n' +
            '     "commands": { "pr-gate": { "checklists": { "doc": ".claude/review/index.md" } } }\n' +
            '   That index doc carries the manifest naming each checklist and which paths trigger it:\n' +
            '     <!-- webpieces:checklists\n' +
            '     [ { "subagent": "db-migration-reviewer", "doc": "db-migrations.md",\n' +
            '         "patterns": ["**/migrations/**", "**/*.sql"] } ]\n' +
            '     -->\n' +
            '   Each entry needs its OWN reviewer subagent — that is how independent review is enforced.'
        );
    }

    private emptyManifest(docRel: string): string {
        return (
            `📋 Review checklists: 0 defined — "${docRel}" is readable but its manifest lists no usable\n` +
            '   checklists (every entry needs a non-empty "subagent"). Fine to proceed; worth a look if\n' +
            '   you expected some to run.'
        );
    }

    // The one case that deserves volume: it LOOKS configured but enforces nothing.
    private misconfigured(docRel: string, manifestErrors: readonly string[]): string {
        return (
            `⚠️  Review checklists: 0 ran because "${docRel}" is MISCONFIGURED — so this PR is getting NO\n` +
            '   checklist review even though this repo asked for one. Not fatal, but almost certainly not\n' +
            '   what you want:\n\n' +
            manifestErrors.map((e: string): string => `     • ${e}`).join('\n')
        );
    }

    private noneMatched(docRel: string, definedCount: number): string {
        return (
            `📋 Review checklists: ${definedCount} defined in "${docRel}", 0 matched this diff — none of their\n` +
            '   path patterns hit a changed file. Expected for changes outside those areas; if you thought\n' +
            '   one should have run, check its "patterns" against the changed-file list above.'
        );
    }
}
