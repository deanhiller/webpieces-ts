import {
    ChecklistDefinition, RequiredChecklist, DiffScope, ChangedFilesOptions, isPathExcluded,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

// A checklist that the branch's diff actually triggered, plus WHY it triggered (the matched files and,
// for content-keyed checklists, the specific added lines). Data-only (per CLAUDE.md, classes for data).
export class TriggeredChecklist {
    def: ChecklistDefinition;
    matchedFiles: string[];
    matchedContent: string[]; // the added diff lines that matched a contentPattern ([] for path-only)

    constructor(def: ChecklistDefinition, matchedFiles: string[], matchedContent: string[]) {
        this.def = def;
        this.matchedFiles = matchedFiles;
        this.matchedContent = matchedContent;
    }
}

/**
 * Decides which consumer review checklists a branch triggered, from what the diff CHANGED. Path
 * triggers use `isPathExcluded` — the SAME minimatch-based matcher rules-config already shares across
 * exclude-paths and the rule validators — so a checklist glob behaves identically to those. (The
 * Dashboard's own hand-rolled gate matcher is deliberately left untouched: changing gate semantics is a
 * separate behavior change per the backlog note, and gates are a different feature.)
 *
 * `@injectable(bindingScopeValues.Singleton)` + injects {@link DiffScope} so it appears in the DI design
 * and reuses the ONE git-diff service instead of adding new git plumbing.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistDetector {
    constructor(private readonly diffScope: DiffScope) {}

    // Pure matching — unit-testable without git. Given the changed files and the added (`+`) lines per
    // file, return every non-disabled checklist that fired.
    detect(
        defs: readonly ChecklistDefinition[],
        changedFiles: readonly string[],
        addedLinesByFile: ReadonlyMap<string, string[]>,
    ): TriggeredChecklist[] {
        const triggered: TriggeredChecklist[] = [];
        for (const def of defs) {
            if (def.disabled) continue;
            const candidates = def.patterns.length === 0
                ? [...changedFiles]
                : changedFiles.filter((f: string): boolean => isPathExcluded(f, def.patterns));
            if (candidates.length === 0) continue;

            if (def.contentPatterns.length === 0) {
                // Path-only trigger: any candidate file firing is enough.
                triggered.push(new TriggeredChecklist(def, candidates, []));
                continue;
            }
            const hit = this.matchContent(def, candidates, addedLinesByFile);
            if (hit.matchedFiles.length > 0) triggered.push(hit);
        }
        return triggered;
    }

    // Content trigger: keep only candidate files with an added line matching a contentPattern. Keying on
    // ADDED lines is why contentPatterns exists — path globs structurally cannot express "a line adding
    // @Post( / @Cron( / CloudTasksClient".
    private matchContent(
        def: ChecklistDefinition,
        candidates: readonly string[],
        addedLinesByFile: ReadonlyMap<string, string[]>,
    ): TriggeredChecklist {
        const regexes = def.contentPatterns.map((p: string): RegExp => new RegExp(p));
        const matchedFiles: string[] = [];
        const matchedContent: string[] = [];
        for (const file of candidates) {
            const lines = addedLinesByFile.get(file) ?? [];
            const hits = lines.filter((l: string): boolean => regexes.some((rx: RegExp): boolean => rx.test(l)));
            if (hits.length > 0) {
                matchedFiles.push(file);
                for (const h of hits) matchedContent.push(h);
            }
        }
        return new TriggeredChecklist(def, matchedFiles, matchedContent);
    }

    // Convenience for the pr-gate commands: resolve the diff base, gather changed files + added lines
    // from git (via the shared DiffScope), then detect. Returns [] when there is no base to diff against.
    detectForRepo(repoRoot: string, defs: readonly ChecklistDefinition[]): TriggeredChecklist[] {
        if (defs.length === 0) return [];
        const range = this.diffScope.resolveBase(repoRoot);
        if (!range.base) return [];
        return this.detectForRange(repoRoot, defs, range.base, range.head);
    }

    // Same detection against an EXPLICIT (base, head) — used by CI (`wp-check-pr`), where the useful
    // range is the PR's merge base .. head rather than the local branch's inferred base. Keep tsOnly=false
    // (see below) so a re-implementation in CI never silently drops the very files a checklist keys on.
    detectForRange(repoRoot: string, defs: readonly ChecklistDefinition[], base: string, head?: string): TriggeredChecklist[] {
        if (defs.length === 0 || !base) return [];

        // tsOnly:false is REQUIRED and load-bearing — the default (true) restricts to *.ts/*.tsx AND
        // drops test files, silently discarding every *.sql / *.gql / Dockerfile / .env* / metadata file
        // a checklist most wants to key on. The default would produce "no checklists triggered".
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        const changedFiles = this.diffScope.getChangedFiles(repoRoot, base, head, opts);

        const addedLinesByFile = new Map<string, string[]>();
        for (const file of changedFiles) {
            const diff = this.diffScope.getFileDiff(repoRoot, file, base, head);
            addedLinesByFile.set(file, this.addedLines(diff));
        }
        return this.detect(defs, changedFiles, addedLinesByFile);
    }

    // The added-content lines of a single-file diff: `+` lines with the marker stripped, excluding the
    // `+++` file header (mirrors DiffScope.getChangedLineNumbers' own `+`/`+++` handling).
    private addedLines(diff: string): string[] {
        const out: string[] = [];
        for (const line of diff.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
        }
        return out;
    }

    // Flatten triggered checklists into the RequiredChecklist shape that review.json validation + the
    // schema hint consume.
    toRequired(triggered: readonly TriggeredChecklist[]): RequiredChecklist[] {
        return triggered.map((t: TriggeredChecklist): RequiredChecklist =>
            new RequiredChecklist(t.def.id, t.def.title, t.def.severity, t.def.docs, t.def.blockMessage, t.matchedFiles, t.def.subagent));
    }
}
