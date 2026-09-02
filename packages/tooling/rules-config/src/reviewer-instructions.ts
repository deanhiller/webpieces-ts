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

/**
 * One reviewer's matched file, the extracted diff for it, AND the absolute path of the file itself.
 *
 * `sourcePath` exists because of a measured 0/4: four reviewers on one PR read the diff and not one opened a
 * single full source file. The instructions handed them an absolute path per diff and only a parent DIRECTORY
 * per source, so reading the diff was a paste and reading the source was "join this dir to that filename
 * yourself". Identical affordance, or the cheaper one wins every time. Data-only.
 */
export class BriefedFile {
    file: string;        // repo-relative source path
    diffPath: string;    // ABSOLUTE path of the extracted .diff
    sourcePath: string;  // ABSOLUTE path of the file itself; '' for a deleted file, which has no after-state
    status: string;      // 'M' | 'A' | 'D' | 'U' (untracked) | 'X' (excluded by config)
    diffBytes: number;
    truncated: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(file: string, diffPath: string, sourcePath = '', status = 'M', diffBytes = 0, truncated = false) {
        this.file = file;
        this.diffPath = diffPath;
        this.sourcePath = sourcePath;
        this.status = status;
        this.diffBytes = diffBytes;
        this.truncated = truncated;
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
    // Facts ABOUT the manifest, surfaced inline so a reviewer learns the diff is complete without opening it.
    changedFileCount: number;
    truncatedCount: number;
    excludedCount: number;
    allDiffLines: number;
    allDiffBytes: number;
    // The three shas, by the names DiffManifest already uses. Printing two bare shas told a reviewer nothing
    // about WHAT the diff is taken against; C beside A makes "main has moved since the fork" self-evident.
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
    ownAgentFileInDiff: string;   // ABSOLUTE path when this diff edits THIS reviewer's own agent file; '' otherwise
    // From the checklist's config `required`. Carried so the stage-② report can group the spawn blocks
    // (must run) apart from the ones the human is merely OFFERED, without a second lookup that could
    // disagree with the scan. The reviewer's OWN instructions do not mention it: a reviewer that has been
    // spawned reviews the same way either way, and telling an optional one it was optional invites it to
    // grade itself softer.
    required: boolean;

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
        this.changedFileCount = 0;
        this.truncatedCount = 0;
        this.excludedCount = 0;
        this.allDiffLines = 0;
        this.allDiffBytes = 0;
        this.hashForkPoint = '';
        this.hashFeatureHead = '';
        this.hashMainHead = '';
        this.ownAgentFileInDiff = '';
        // Fails CLOSED, like RequiredChecklist.required: a briefing built without the flag being copied is
        // treated as a blocking reviewer, never as a skippable one.
        this.required = true;
    }
}

/**
 * The Read tool truncates at roughly this many lines, silently. Any path this file prints alongside a bigger
 * line count has to say so, or a reviewer reviews a fraction of a change and reports on all of it.
 */
export const READ_TRUNCATION_LINES = 2000;

/** Comfortably under {@link READ_TRUNCATION_LINES} — the size at which ALL.diff really is one clean Read. */
export const ALL_DIFF_ONE_READ_LINES = 1500;

/**
 * Renders the per-reviewer instructions file that `wp-review-upsert-pr` writes to
 * `.webpieces/pr-review/<feature>/instructions/<subagent>.instructions.md`.
 *
 * WHY this file exists, measured rather than assumed: a reviewer subagent on consumer-monorepo2 spent **14 of its
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
            'You may not write another reviewer\'s verdict file.',
            '',
            '"You may not review your own authorship" means: you did not write this diff, so review it — but if',
            'the diff CHANGES YOU, say so in `output` rather than pretending the conflict is not there.',
            ...this.selfEditWarning(b),
            '',
            '_Generated per run by `wp-review-upsert-pr`. Everything below is already resolved for you; the',
            'paths are absolute because your working directory is not guaranteed to be the repo root._',
            '',
        ];
    }

    /**
     * Every PR that edits the review gate hits this: on the measured run, 5 of 8 changed files were the
     * reviewer agent files themselves, two reviewers reviewed their OWN definition, and neither flagged it —
     * neither had any guidance to. Detected by the tooling rather than left to the reviewer to notice.
     */
    private selfEditWarning(b: ReviewerBriefing): string[] {
        if (b.ownAgentFileInDiff === '') return [];
        return [
            '',
            `⚠️  THIS DIFF MODIFIES YOUR OWN AGENT FILE: \`${b.ownAgentFileInDiff}\``,
            'You are reviewing a change to your own definition. Review it anyway — and state that fact in',
            '`output`, so a human reading your verdict knows the reviewer and the reviewed were the same thing.',
        ];
    }

    private checklistSection(b: ReviewerBriefing): string[] {
        if (b.docPath === '') {
            return ['## Your checklist', '', 'This checklist has no guidance doc — judge the diff on your own standards.', ''];
        }
        return ['## Your checklist', '', `Read this FIRST: \`${b.docPath}\``, ''];
    }

    /**
     * The change itself. The MANIFEST leads, and the per-file table with it; `ALL.diff` is demoted to one
     * option among several, recommended only where it is actually the right read.
     *
     * That ordering is the fix for a measured 4/4 failure. `ALL.diff` used to be bolded, first, and framed as
     * "everything", with the manifest one unbolded line below it called a "path map" — which reads like a
     * lookup aid, not something to open. All four reviewers on that PR read `ALL.diff`, none opened the
     * manifest, and none could therefore have established that the combined view was complete. Reviewers did
     * exactly what the emphasis told them to; so the emphasis moved.
     */
    private diffSection(b: ReviewerBriefing): string[] {
        const lines = ['## The change you are reviewing', ''];
        if (b.dirty) {
            lines.push('> ⚠️ This diff INCLUDES uncommitted and untracked work, so it is not what a');
            lines.push('> commit-to-commit range would show. Judge it anyway — it is what your checklist matched.');
            lines.push('');
        }
        lines.push(...this.manifestLines(b), ...this.basisLines(b), ...this.myFilesTable(b), ...this.allDiffLines(b));
        if (b.fileDiffCommand !== '') {
            lines.push(`Reproduce any single file: \`${b.fileDiffCommand}\``);
            lines.push('');
        }
        lines.push('Path matching is COARSE. Judge the change, not the path — if a matched file turns out to be');
        lines.push('irrelevant to your checklist, say so in one sentence and move on.');
        lines.push('');
        return lines;
    }

    /**
     * The manifest, named as the authority AND with its own headline facts inlined. Inlining them is the
     * point: a reviewer that never opens the manifest still learns whether anything was truncated or
     * excluded, which is the one thing it could not otherwise have known it was missing.
     */
    private manifestLines(b: ReviewerBriefing): string[] {
        if (b.manifestPath === '') return [];
        const warn = b.truncatedCount + b.excludedCount > 0 ? '  ⚠️ NOT everything is materialized — see the table.' : '';
        return [
            `**Path map — AUTHORITATIVE. Read this first:** \`${b.manifestPath}\``,
            `  ${b.changedFileCount} file(s) · ${b.truncatedCount} truncated · ${b.excludedCount} excluded${warn}`,
            '  Per file it carries: `status` (M/A/D/U/X), `bytes`, `file`/`fileAbs`, `diffFile`/`diffAbs`, and the',
            '  three shas below. It is the only place that records what was truncated or left out.',
            '',
        ];
    }

    /**
     * What the diff is taken AGAINST. Two bare shas in a `git diff` command said nothing about this, so a
     * reviewer could not tell a fork-point diff from a diff against main's current tip — and therefore could
     * not tell that anything merged to main since the fork is simply absent from what it is judging.
     * Rendering C beside A makes "main has moved" self-evident exactly when it has.
     */
    private basisLines(b: ReviewerBriefing): string[] {
        if (b.hashForkPoint === '') return [];
        const sameAsFork = b.hashMainHead === b.hashForkPoint;
        const cNote = b.hashMainHead === '' ? '(unresolved)'
            : sameAsFork ? `${b.hashMainHead}   ← same as A, so main has not moved since the fork`
            : `${b.hashMainHead}   ← main HAS MOVED since the fork`;
        return [
            'This diff is **fork-point → feature-head**, NOT a diff against main\'s current tip:',
            '```',
            `fork point   (A)  ${b.hashForkPoint}`,
            `feature head (B)  ${b.hashFeatureHead}`,
            `main head    (C)  ${cNote}`,
            '```',
            'Anything merged to main after A is NOT in this diff.',
            '',
        ];
    }

    /**
     * Source and diff get IDENTICAL affordance — an absolute path each, in adjacent columns. The previous
     * table gave an absolute path for the diff and nothing for the source, and the source went unread 4/4.
     */
    private myFilesTable(b: ReviewerBriefing): string[] {
        if (b.myFiles.length === 0) return ['_No files matched your patterns._', ''];
        const why = b.matchedPatterns.length === 0
            ? `**In scope: ALL ${b.myFiles.length} changed file(s)** — your checklist has no \`patterns\`, so the whole diff is yours.`
            : `**In scope: ${b.myFiles.length} file(s)** matching ${b.matchedPatterns.map((p: string): string => `\`${p}\``).join(', ')}:`;
        const rows = b.myFiles.map((f: BriefedFile): string => this.fileRow(f));
        return [why, '', '| file | status | its diff | full source |', '|---|---|---|---|', ...rows, ''];
    }

    /**
     * One row. A truncated or excluded diff is flagged HERE, in the row, not left as a field inside a file the
     * reviewer has to think to open — and an oversized diff states the line count that makes a single Read
     * come back silently incomplete.
     */
    private fileRow(f: BriefedFile): string {
        const flags: string[] = [];
        if (f.truncated) flags.push('⚠️ diff TRUNCATED — read the source');
        if (f.status === 'X') flags.push('⚠️ EXCLUDED, not materialized — read the source');
        const status = [`\`${f.status}\``, ...flags].join(' ');
        const source = f.sourcePath === '' ? '_deleted — no file on disk_' : `\`${f.sourcePath}\``;
        return `| \`${f.file}\` | ${status} | \`${f.diffPath}\` (${f.diffBytes} bytes) | ${source} |`;
    }

    /**
     * `ALL.diff`, recommended ONLY where it is the right read. It is kept — for a patternless reviewer on a
     * small diff it is genuinely one Read instead of N, which is why all four used it — but the blanket
     * "everything on this branch" line was wrong in two different ways at once: it invited a pattern-scoped
     * reviewer to spend its budget on files it was explicitly not asked about, and it pointed a reviewer on a
     * large PR at a file that cannot survive one Read.
     */
    private allDiffLines(b: ReviewerBriefing): string[] {
        if (b.allDiffPath === '') return [];
        const size = b.allDiffLines === 0 ? '' : ` — ${b.allDiffLines} lines / ${b.allDiffBytes} bytes`;
        if (b.matchedPatterns.length > 0) {
            return [`The whole branch${size}, for CROSS-FILE CONTEXT if you need it: \`${b.allDiffPath}\``,
                'Your own files above are what you are reviewing; the rest of the branch is someone else\'s checklist.', ''];
        }
        if (b.allDiffLines > ALL_DIFF_ONE_READ_LINES) {
            return [`⚠️ The combined diff is ${b.allDiffLines} lines and will NOT survive a single Read (the Read tool`,
                `truncates at ~${READ_TRUNCATION_LINES} lines, silently). Read the per-file diffs above instead, or page it:`,
                `\`${b.allDiffPath}\``, ''];
        }
        return [`Whole-branch diff${size} — convenient at this size, but the per-file table above is authoritative:`,
            `\`${b.allDiffPath}\``, ''];
    }

    /**
     * The rule that used to say "when you need to", and lost 4/4 to the more emphatic budget section 40 lines
     * later. "When you need to" delegates the judgment to a reviewer that, by construction, does not yet know
     * what it is missing. It has no opt-out now.
     */
    private sourceSection(b: ReviewerBriefing): string[] {
        const lines = ['## Read the full source — every file, every time', '', `Repo root: \`${b.repoRoot}\``, ''];
        lines.push('**READ THE FULL SOURCE OF EVERY FILE IN YOUR TABLE.** Not "if you need to" — every time.');
        lines.push('A hunk shows what changed; only the whole file shows what it changed INTO, and a change that');
        lines.push('looks fine in isolation can still be wrong in place.');
        lines.push('');
        lines.push('The `full source` column above is the path. For files marked `A` (added) you have already done');
        lines.push('this: an add-diff IS the complete file, byte for byte, so its diff and its source are the same');
        lines.push('text. For `M` (modified) and `D` (deleted) files the diff is a fragment — open the file.');
        lines.push('');
        if (b.sourceDirs.length > 0) {
            lines.push('The neighbouring code lives under:');
            for (const dir of b.sourceDirs) lines.push(`- \`${dir}\``);
            lines.push('');
        }
        return lines;
    }

    /**
     * The section that deletes the `node_modules` greps. Entries come from config, because the tooling
     * cannot guess that a repo keeps its queue names in terraform — but it CAN resolve where a package
     * installed to, and it must never drop an entry silently: a missing path is stated as missing.
     */
    private contextSection(b: ReviewerBriefing): string[] {
        // Emitting NOTHING made the section this class exists for look like a feature that does not exist.
        // One line naming the config keys costs nothing and is the only hint a repo will ever get.
        if (b.contextEntries.length === 0) {
            return ['## Pre-resolved context', '',
                '_None configured for this repo. If you find yourself hunting for the same path on every review,',
                'it belongs in `pr-gate.reviewContext` / `pr-gate.reviewContextPackages` in `webpieces.config.json`._',
                ''];
        }
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

    /**
     * The anti-hunting rule, with the changed files carved out explicitly.
     *
     * It used to read as "stay inside what you were given" and, being the LAST thing in the file, it beat
     * the source-reading instruction 4 times out of 4. It never distinguished HUNTING — greps into
     * `node_modules`, re-deriving the dependency graph — from OPENING A FILE IT WAS EXPLICITLY HANDED. The
     * distinction is now stated, because where two instructions conflict the later and more emphatic one wins.
     */
    private budgetSection(): string[] {
        return [
            '## Budget',
            '',
            'Do NOT search `node_modules`, do NOT re-derive the dependency graph, and do NOT hunt the repo for',
            'infrastructure config. That is hunting, and it is what wastes a review budget — those paths are',
            'either given above or were not configured.',
            '',
            'Reading the full text of a file that is IN your table is NOT hunting — it is the review. Budget for',
            'it: read the diff to see what changed, and the source to judge whether it is right in place.',
            '',
            'If something you genuinely need is missing, name it in `output` and give your verdict on what you',
            'could actually see.',
            '',
            'Open your diff files before writing a verdict. `wp-finish-upsert-pr` reads your own transcript and',
            'reports a verdict written without opening the diff. It also records the path of that transcript,',
            'beside what you were offered and what you read, in `provenance.json` next to your verdict file —',
            'so the review is auditable after the fact. You do not write that file; the tooling does.',
        ];
    }
}
