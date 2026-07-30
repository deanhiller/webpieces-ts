import {
    ChecklistDefinition, RequiredChecklist, DiffScope, ChangedFilesOptions, isPathExcluded,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

// A checklist whose `patterns` matched the diff (so its reviewer subagent must run), plus the matched
// files (for the dashboard + hint). Data-only (per CLAUDE.md, classes for data).
export class TriggeredChecklist {
    def: ChecklistDefinition;
    matchedFiles: string[];
    // Which of `def.patterns` actually hit a changed file. Carried so the printed instruction can say WHAT
    // matched, not just which files: a reviewer judges a `db/migrations/**` hit differently from a `**` one.
    matchedPatterns: string[];

    constructor(def: ChecklistDefinition, matchedFiles: string[], matchedPatterns: string[] = []) {
        this.def = def;
        this.matchedFiles = matchedFiles;
        this.matchedPatterns = matchedPatterns;
    }
}

/**
 * Decides which company review checklists a branch matched, from what the diff CHANGED. Path matching
 * uses `isPathExcluded` — the SAME minimatch-based matcher rules-config already shares across
 * exclude-paths and the rule validators. A checklist with empty `patterns` matches every PR (always runs).
 *
 * `@injectable(bindingScopeValues.Singleton)` + injects {@link DiffScope} so it appears in the DI design
 * and reuses the ONE git-diff service instead of adding new git plumbing.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistDetector {
    constructor(private readonly diffScope: DiffScope) {}

    // Pure matching — unit-testable without git. Return every checklist whose patterns hit a changed file
    // (empty patterns ⇒ always matches).
    detect(defs: readonly ChecklistDefinition[], changedFiles: readonly string[]): TriggeredChecklist[] {
        const triggered: TriggeredChecklist[] = [];
        for (const def of defs) {
            const matched = def.patterns.length === 0
                ? [...changedFiles]
                : changedFiles.filter((f: string): boolean => isPathExcluded(f, def.patterns));
            if (matched.length > 0) triggered.push(new TriggeredChecklist(def, matched, this.firedPatterns(def, changedFiles)));
        }
        return triggered;
    }

    // Which of a checklist's globs hit at least one changed file. [] for a patternless checklist (it matches
    // every PR, and saying "matched by nothing" would read as a bug).
    private firedPatterns(def: ChecklistDefinition, changedFiles: readonly string[]): string[] {
        return def.patterns.filter((p: string): boolean => changedFiles.some((f: string): boolean => isPathExcluded(f, [p])));
    }

    // Resolve the diff base for the local branch, then detect. Returns [] when there is no base to diff.
    detectForRepo(repoRoot: string, defs: readonly ChecklistDefinition[]): TriggeredChecklist[] {
        if (defs.length === 0) return [];
        const range = this.diffScope.resolveBase(repoRoot);
        if (!range.base) return [];
        return this.detectForRange(repoRoot, defs, range.base, range.head);
    }

    // Same detection against an EXPLICIT (base, head) — used by CI, where the useful range is the PR's
    // merge base .. head. tsOnly=false is load-bearing: the default drops every *.sql / Dockerfile / .env*
    // / metadata file a checklist most wants to key on, silently producing "no checklists matched".
    detectForRange(repoRoot: string, defs: readonly ChecklistDefinition[], base: string, head?: string): TriggeredChecklist[] {
        if (defs.length === 0 || !base) return [];
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        const changedFiles = this.diffScope.getChangedFiles(repoRoot, base, head, opts);
        return this.detect(defs, changedFiles);
    }

    // Flatten matched checklists into the RequiredChecklist shape that review.json enforcement + the hint
    // consume.
    toRequired(triggered: readonly TriggeredChecklist[]): RequiredChecklist[] {
        return triggered.map((t: TriggeredChecklist): RequiredChecklist =>
            new RequiredChecklist(t.def.id, t.def.subagent, t.def.doc, t.matchedFiles, t.matchedPatterns));
    }
}
