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
 * Every DEFINED checklist paired with what it matched, plus the two facts a reader needs to judge a skip:
 * how many files were even considered, and whether a diff was computable at all. Data-only (per CLAUDE.md).
 */
export class ChecklistRoster {
    entries: TriggeredChecklist[]; // one per defined checklist, in config order; matchedFiles may be []
    changedFileCount: number;      // N — "matched 0 of N changed files" is only meaningful with N
    /**
     * false when no fork point resolved. Load-bearing: with no base the changed-file set is EMPTY, so
     * nothing matches — including patternless ALWAYS-RUNS checklists. Rendering that as "all skipped ✅"
     * would post a green all-clear to GitHub for a PR where no checklist was actually evaluated.
     */
    baseResolved: boolean;

    constructor(entries: TriggeredChecklist[], changedFileCount: number, baseResolved: boolean) {
        this.entries = entries;
        this.changedFileCount = changedFileCount;
        this.baseResolved = baseResolved;
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

    /**
     * Pure matching over EVERY defined checklist, matched or not — one entry per def, in config order, with
     * `matchedFiles: []` for the ones nothing hit. This is what lets the PR comment publish the full roster:
     * a skipped checklist is the normal, healthy outcome, and a comment that lists only the ones that fired
     * cannot distinguish "evaluated and irrelevant" from "never configured".
     *
     * A skipped entry has `matchedPatterns: []` — and so does a PATTERNLESS one. They mean opposite things,
     * so a renderer must decide "always runs" from `def.patterns.length === 0`, NEVER from
     * `matchedPatterns.length`, or every skipped checklist claims the whole diff was in its scope.
     */
    roster(defs: readonly ChecklistDefinition[], changedFiles: readonly string[]): TriggeredChecklist[] {
        return defs.map((def: ChecklistDefinition): TriggeredChecklist => {
            const matched = def.patterns.length === 0
                ? [...changedFiles]
                : changedFiles.filter((f: string): boolean => isPathExcluded(f, def.patterns));
            return new TriggeredChecklist(def, matched, this.firedPatterns(def, changedFiles));
        });
    }

    // Pure matching — unit-testable without git. Return every checklist whose patterns hit a changed file
    // (empty patterns ⇒ always matches). Defined as the roster minus the empty entries so the set that GATES
    // and the set the comment REPORTS can never be computed two different ways.
    detect(defs: readonly ChecklistDefinition[], changedFiles: readonly string[]): TriggeredChecklist[] {
        return this.roster(defs, changedFiles)
            .filter((t: TriggeredChecklist): boolean => t.matchedFiles.length > 0);
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
