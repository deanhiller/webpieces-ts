import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { ReviewJsonService } from './review-json';

/** One pre-resolved place a reviewer would otherwise have to go hunting for. Data-only (per CLAUDE.md). */
export class ContextEntry {
    label: string;
    path: string;     // ABSOLUTE, or '' when it could not be resolved
    note: string;     // '(not installed)' / '(configured but missing)' — never silently dropped

    constructor(label: string, entryPath: string, note = '') {
        this.label = label;
        this.path = entryPath;
        this.note = note;
    }
}

/** One reviewer's matched file and the extracted diff for it. Data-only. */
export class BriefedFile {
    file: string;      // repo-relative source path
    diffPath: string;  // ABSOLUTE path of the extracted .diff

    constructor(file: string, diffPath: string) {
        this.file = file;
        this.diffPath = diffPath;
    }
}

/**
 * Everything ONE reviewer needs, with every path already resolved to an ABSOLUTE one.
 *
 * Absolute is not fussiness: a subagent's working directory is not guaranteed to be the repo root, and a
 * relative path that fails to resolve turns into a search, which is the cost this whole class exists to
 * remove. Data-only.
 */
export class ReviewerBriefing {
    subagent: string;
    docPath: string;              // the checklist's guidance doc ('' when the checklist has none)
    repoRoot: string;
    diffDir: string;              // '' when nothing was materialized
    allDiffPath: string;
    manifestPath: string;
    myFiles: BriefedFile[];       // ONLY this reviewer's matched files
    matchedPatterns: string[];    // [] ⇒ patternless: the whole diff is in scope
    sourceDirs: string[];         // deduped ABSOLUTE parent dirs of myFiles
    contextEntries: ContextEntry[];
    verdictPath: string;          // ABSOLUTE review-<id>.json
    checklistId: string;
    fileDiffCommand: string;
    dirty: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(subagent: string, checklistId: string, repoRoot: string) {
        this.subagent = subagent;
        this.checklistId = checklistId;
        this.repoRoot = repoRoot;
        this.docPath = '';
        this.diffDir = '';
        this.allDiffPath = '';
        this.manifestPath = '';
        this.myFiles = [];
        this.matchedPatterns = [];
        this.sourceDirs = [];
        this.contextEntries = [];
        this.verdictPath = '';
        this.fileDiffCommand = '';
        this.dirty = false;
    }
}

/**
 * Renders the per-reviewer instructions file that `wp-review-upsert-pr` writes to
 * `.webpieces/pr-review/<feature>/instructions/<subagent>.instructions.md`.
 *
 * WHY this file exists, measured rather than assumed: a reviewer subagent on monorepo-nx2 spent **14 of its
 * 26 tool calls** rediscovering context the tooling already had — three separate greps into
 * `node_modules/@webpieces` to locate a scanner, a hunt through terraform for queue names, and a
 * re-derivation of the dependency graph. It did not over-review; it was under-supplied. Everything below is
 * chosen to delete a specific one of those calls.
 *
 * It is GENERATED per run, and the registered `.claude/agents/<subagent>.md` is a thin stub that points
 * here, because content a human maintains goes stale and a reviewer follows the stale copy. The verdict
 * schema in particular comes from {@link ReviewJsonService.verdictSchemaFor}.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewerInstructionsService {
    constructor(private readonly reviewJsonService: ReviewJsonService) {}

    /** The dir holding this branch's generated instructions, beside its review.json. */
    instructionsDirFor(repoRoot: string, featureName: string): string {
        return path.join(this.reviewJsonService.prDirFor(repoRoot, featureName), 'instructions');
    }

    /** The file name for a reviewer's generated instructions. */
    fileNameFor(subagent: string): string {
        return `${subagent}.instructions.md`;
    }

    /** Absolute path of one reviewer's generated instructions file. */
    pathFor(repoRoot: string, featureName: string, subagent: string): string {
        return path.join(this.instructionsDirFor(repoRoot, featureName), this.fileNameFor(subagent));
    }

    render(briefing: ReviewerBriefing): string {
        return [
            ...this.identity(briefing),
            ...this.checklistSection(briefing),
            ...this.diffSection(briefing),
            ...this.sourceSection(briefing),
            ...this.contextSection(briefing),
            ...this.verdictSection(briefing),
            ...this.budgetSection(),
        ].join('\n') + '\n';
    }

    private identity(b: ReviewerBriefing): string[] {
        return [
            `# You are \`${b.subagent}\``,
            '',
            'Review as YOURSELF, against your own checklist — not as a general code reviewer.',
            'You may not review your own authorship, and you may not write another reviewer\'s verdict file.',
            '',
            '_Generated per run by `wp-review-upsert-pr`. Everything below is already resolved for you; the',
            'paths are absolute because your working directory is not guaranteed to be the repo root._',
            '',
        ];
    }

    private checklistSection(b: ReviewerBriefing): string[] {
        if (b.docPath === '') {
            return ['## Your checklist', '', 'This checklist has no guidance doc — judge the diff on your own standards.', ''];
        }
        return ['## Your checklist', '', `Read this FIRST: \`${b.docPath}\``, ''];
    }

    /**
     * The change itself. The materialized diff leads because it is ONE Read instead of a shell-out per file,
     * and because a hand-assembled range can come back empty (it did — see DiffBasis).
     */
    private diffSection(b: ReviewerBriefing): string[] {
        const lines = ['## The change you are reviewing', ''];
        if (b.dirty) {
            lines.push('> ⚠️ This diff INCLUDES uncommitted and untracked work, so it is not what a');
            lines.push('> commit-to-commit range would show. Judge it anyway — it is what your checklist matched.');
            lines.push('');
        }
        if (b.allDiffPath !== '') {
            lines.push(`**Everything on this branch, already extracted:** \`${b.allDiffPath}\``);
            lines.push('');
        }
        lines.push(...this.myFilesTable(b));
        if (b.manifestPath !== '') {
            lines.push(`Path map (authoritative; records truncated + excluded files): \`${b.manifestPath}\``);
            lines.push('');
        }
        if (b.fileDiffCommand !== '') {
            lines.push(`Reproduce any single file: \`${b.fileDiffCommand}\``);
            lines.push('');
        }
        lines.push('Path matching is COARSE. Judge the change, not the path — if a matched file turns out to be');
        lines.push('irrelevant to your checklist, say so in one sentence and move on.');
        lines.push('');
        return lines;
    }

    private myFilesTable(b: ReviewerBriefing): string[] {
        if (b.myFiles.length === 0) return ['_No files matched your patterns._', ''];
        const why = b.matchedPatterns.length === 0
            ? `**In scope: ALL ${b.myFiles.length} changed file(s)** — your checklist has no \`patterns\`, so the whole diff is yours.`
            : `**In scope: ${b.myFiles.length} file(s)** matching ${b.matchedPatterns.map((p: string): string => `\`${p}\``).join(', ')}:`;
        const rows = b.myFiles.map((f: BriefedFile): string => `| \`${f.file}\` | \`${f.diffPath}\` |`);
        return [why, '', '| file | its diff |', '|---|---|', ...rows, ''];
    }

    private sourceSection(b: ReviewerBriefing): string[] {
        const lines = ['## Where the source lives', '', `Repo root: \`${b.repoRoot}\``, ''];
        if (b.sourceDirs.length > 0) {
            lines.push('Your matched files live under:');
            for (const dir of b.sourceDirs) lines.push(`- \`${dir}\``);
            lines.push('');
        }
        lines.push('Read whole files around the diff when you need to. The diff is the SUBJECT; the surrounding');
        lines.push('code is the CONTEXT — a change that looks fine in isolation can still be wrong in place.');
        lines.push('');
        return lines;
    }

    /**
     * The section that deletes the `node_modules` greps. Entries come from config, because the tooling
     * cannot guess that a repo keeps its queue names in terraform — but it CAN resolve where a package
     * installed to, and it must never drop an entry silently: a missing path is stated as missing.
     */
    private contextSection(b: ReviewerBriefing): string[] {
        if (b.contextEntries.length === 0) return [];
        const lines = ['## Pre-resolved context (do not go hunting for these)', ''];
        for (const entry of b.contextEntries) {
            const suffix = entry.note === '' ? '' : `  ${entry.note}`;
            lines.push(`- **${entry.label}** — \`${entry.path === '' ? entry.note : entry.path}\`${entry.path === '' ? '' : suffix}`);
        }
        lines.push('');
        return lines;
    }

    /**
     * The verdict shape, GENERATED — never restated in a hand-maintained file. `id` is pre-filled with this
     * reviewer's own checklist id so there is nothing to substitute and nothing to get wrong.
     */
    private verdictSection(b: ReviewerBriefing): string[] {
        return [
            '## Write your verdict',
            '',
            `Write EXACTLY this shape, to EXACTLY this file: \`${b.verdictPath}\``,
            '',
            '```',
            this.reviewJsonService.verdictSchemaFor(b.checklistId, '', ''),
            '```',
            '',
        ];
    }

    private budgetSection(): string[] {
        return [
            '## Budget',
            '',
            'Everything you need is listed above. Do NOT search `node_modules`, do NOT re-derive the dependency',
            'graph, and do NOT hunt the repo for infrastructure config — those paths are either given above or',
            'were not configured. If something you genuinely need is missing, name it in `output` and give your',
            'verdict on what you could actually see. A reviewer that spends its budget searching produces a',
            'thinner review than one that spends it reading.',
            '',
            'Open your diff files before writing a verdict. `wp-finish-upsert-pr` reads your own transcript and',
            'reports a verdict written without opening the diff.',
        ];
    }
}
