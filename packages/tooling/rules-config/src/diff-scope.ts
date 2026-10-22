/**
 * Shared git-diff + diff-scoping service for ALL rule validators (code-rules) and nx executors
 * (nx-webpieces-rules). Centralized here in rules-config because it is the one package both depend on.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it can be injected and appear in the rules-config DI design. Free-function
 * delegators are kept temporarily so the many existing consumers stay green; they migrate to injecting
 * {@link DiffScope} over follow-up PRs, then the delegators are removed.
 *
 * Every git call goes through the injected {@link GitProcessApi} (#1381), so a program resolved from a
 * container whose git edge is rebound to a mock reads its diff from scripted git. The free delegators below
 * reach the REAL edge — a caller that is feature-tested injects DiffScope instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { GitProcessApi, GitProcessClient, InformAiError } from '@webpieces/tooling-common';

import { RuleFileScope } from './rule-file-scope';

/** A git diff range: the base ref to compare against and an optional head (else the working tree). */
export class DiffRange {
    base?: string;
    head?: string;
}

/** Options for getChangedFiles. `tsOnly` (default true) restricts to *.ts/*.tsx and drops test files. */
export class ChangedFilesOptions {
    tsOnly?: boolean;
    /**
     * Include DELETED files in the result. Default false, which is `--diff-filter=d` — the historical
     * behavior, kept as the default so every existing caller is byte-identical.
     *
     * The default is right for lint validators (you cannot lint a file that is gone) and WRONG for checklist
     * matching: a PR that DELETES a migration, an auth check or a terraform rule changed exactly the thing a
     * checklist exists to catch, and dropping it from the changed-file set means the checklist never fires
     * and no reviewer is ever asked. The review flow sets this true.
     */
    includeDeletions?: boolean;
}

@injectable(bindingScopeValues.Singleton)
export class DiffScope {
    // Stateless reader of the rule run in progress (an AsyncLocalStorage store), not a dependency.
    private readonly ruleFileScope = new RuleFileScope();

    // Defaulted so the free delegators below can `new DiffScope()`, while inversify injects the container's
    // git edge — which is what a feature test rebinds.
    constructor(private readonly git: GitProcessApi = new GitProcessClient()) {}

    /** Auto-detect the diff base: merge-base of HEAD with origin/main, falling back to local main. */
    async detectBase(workspaceRoot: string): Promise<string | null> {
        for (const ref of ['origin/main', 'main']) {
            // A failure (no such ref, not a repo) just tries the next ref.
            const result = await this.git.run(['merge-base', 'HEAD', ref], workspaceRoot);
            const merged = result.ok ? result.stdout.trim() : '';
            if (merged) return merged;
        }
        return null;
    }

    /** Resolve the diff range a rule should compare against (honors nx's NX_BASE / NX_HEAD). */
    async resolveBase(workspaceRoot: string): Promise<DiffRange> {
        const range = new DiffRange();
        range.base = process.env['NX_BASE'];
        range.head = process.env['NX_HEAD'];
        if (!range.base) {
            range.base = (await this.detectBase(workspaceRoot)) ?? undefined;
        }
        return range;
    }

    /**
     * Changed files between base and head (or base→working-tree when head is omitted). Untracked files
     * are unioned in for the working-tree case. `tsOnly` (default true) restricts to *.ts/*.tsx and
     * drops test files. Deletions are excluded (`--diff-filter=d`).
     *
     * Inside a rule run, the files that run's path exclusions match are dropped (#1253): this listing is
     * where the framework applies the top-level and per-rule `excludePaths`, so no rule does it itself.
     */
    async getChangedFiles(workspaceRoot: string, base: string, head?: string, opts?: ChangedFilesOptions): Promise<string[]> {
        return this.ruleFileScope.filter(await this.listChangedFiles(workspaceRoot, base, head, opts));
    }

    private async listChangedFiles(workspaceRoot: string, base: string, head?: string, opts?: ChangedFilesOptions): Promise<string[]> {
        const tsOnly = opts?.tsOnly ?? true;
        const glob = tsOnly ? ['--', '*.ts', '*.tsx'] : [];
        const keep = (f: string): boolean => f.length > 0 && (!tsOnly || !this.isTestFile(f));
        // Deletions are excluded by default (see ChangedFilesOptions.includeDeletions) — the review flow
        // opts in, every lint validator keeps the historical filter.
        const filter = opts?.includeDeletions === true ? [] : ['--diff-filter=d'];
        const diffTarget = head ? [base, head] : [base];
        const diff = await this.git.run(['diff', '--name-only', ...filter, ...diffTarget, ...glob], workspaceRoot);
        // A failed `git diff` returns an empty list.
        if (!diff.ok) return [];
        const changedFiles = diff.stdout.trim().split('\n').filter(keep);

        // Working-tree comparison (no head): also include untracked files, as nx affected does.
        if (head) return changedFiles;
        const untracked = await this.git.run(['ls-files', '--others', '--exclude-standard', ...glob], workspaceRoot);
        // An `ls-files` failure falls back to the tracked list.
        if (!untracked.ok) return changedFiles;
        const untrackedFiles = untracked.stdout.trim().split('\n').filter(keep);
        return Array.from(new Set([...changedFiles, ...untrackedFiles]));
    }

    /**
     * EVERY file in the working tree — tracked plus untracked-not-ignored, minus files deleted on disk —
     * filtered exactly like {@link getChangedFiles} (`tsOnly` default true: *.ts/*.tsx, no test files).
     * The file set of the whole-scope modes (#1027): RUN_EVERY_TIME judges all of it, MODIFIED_PROJECTS the
     * part owned by a touched project. Git, not a directory walk, so `.gitignore` (node_modules, dist)
     * is honoured for free.
     *
     * Unlike getChangedFiles it does NOT swallow a git failure into an empty list: an empty whole-scope
     * listing reads as "0 sites left", a false answer to exactly the question these modes exist to
     * answer, so a failed `git ls-files` throws and fails the run.
     *
     * Inside a rule run, the run's path exclusions are applied exactly as in {@link getChangedFiles}.
     */
    async getAllFiles(workspaceRoot: string, opts?: ChangedFilesOptions): Promise<string[]> {
        return this.ruleFileScope.filter(await this.listAllFiles(workspaceRoot, opts));
    }

    private async listAllFiles(workspaceRoot: string, opts?: ChangedFilesOptions): Promise<string[]> {
        const tsOnly = opts?.tsOnly ?? true;
        const glob = tsOnly ? ['--', '*.ts', '*.tsx'] : [];
        const listed = await this.git.run(['ls-files', '--cached', '--others', '--exclude-standard', ...glob], workspaceRoot);
        if (!listed.ok) {
            throw new InformAiError(
                `\`git ls-files\` failed in ${workspaceRoot} (exit ${String(listed.code)}): ${listed.stderr.trim()}. `
                + 'A whole-scope rule run cannot list the working tree; repair git access there, then retry.');
        }
        const output = listed.stdout;
        const keep = (f: string): boolean =>
            f.length > 0 && (!tsOnly || !this.isTestFile(f)) && fs.existsSync(path.join(workspaceRoot, f));
        return Array.from(new Set(output.trim().split('\n').filter(keep)));
    }

    /** Diff content for a single file (synthetic all-added diff for an untracked file with no head). */
    async getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): Promise<string> {
        const diffTarget = head ? [base, head] : [base];
        const result = await this.git.run(['diff', ...diffTarget, '--', file], workspaceRoot);
        // A failed `git diff` returns no diff.
        if (!result.ok) return '';
        const diff = result.stdout;
        if (diff || head) return diff;

        const fullPath = path.join(workspaceRoot, file);
        if (!fs.existsSync(fullPath)) return diff;
        const untracked = await this.git.run(['ls-files', '--others', '--exclude-standard', '--', file], workspaceRoot);
        if (!untracked.ok || untracked.stdout.trim() === '') return diff;
        const content = fs.readFileSync(fullPath, 'utf-8');
        return content.split('\n').map((l: string) => `+${l}`).join('\n');
    }

    /** Added/changed line numbers (the `+` lines per hunk) — basis of NEW_AND_MODIFIED_CODE scoping. */
    getChangedLineNumbers(diffContent: string): Set<number> {
        const changedLines = new Set<number>();
        const lines = diffContent.split('\n');
        let currentLine = 0;

        for (const line of lines) {
            const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                currentLine = parseInt(hunkMatch[1], 10);
                continue;
            }

            if (line.startsWith('+') && !line.startsWith('+++')) {
                changedLines.add(currentLine);
                currentLine++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                // Deletions don't advance the new-file line counter.
            } else {
                currentLine++;
            }
        }

        return changedLines;
    }

    /** Method names whose signature line is a `+` addition in the diff — the basis of "NEW" methods. */
    findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
        const newMethods = new Set<string>();
        const lines = diffContent.split('\n');

        const patterns = [
            /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
            /^\+\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
            /^\+\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
            /^\+\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
        ];

        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                for (const pattern of patterns) {
                    const match = line.match(pattern);
                    if (match) {
                        const methodName = match[1];
                        if (methodName && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodName)) {
                            newMethods.add(methodName);
                        }
                        break;
                    }
                }
            }
        }

        return newMethods;
    }

    /** True if any line in [startLine, endLine] is in the changedLines set. */
    hasChangesInRange(startLine: number, endLine: number, changedLines: Set<number>): boolean {
        for (let line = startLine; line <= endLine; line++) {
            if (changedLines.has(line)) {
                return true;
            }
        }
        return false;
    }

    /** True if a node (method/function) is newly added or has any changed line in its range. */
    isNewOrModified(
        name: string,
        startLine: number,
        endLine: number,
        changedLines: Set<number>,
        newMethodNames: Set<string>,
    ): boolean {
        if (newMethodNames.has(name)) return true;
        return this.hasChangesInRange(startLine, endLine, changedLines);
    }

    // A file is "a test file" (excluded from diff-scoped rules) when it is a .spec/.test file or lives
    // under a __tests__/ directory.
    private isTestFile(file: string): boolean {
        return file.includes('.spec.ts') || file.includes('.test.ts') || file.includes('__tests__/');
    }
}

// Temporary migration delegators to DiffScope — removed once consumers inject it.
const diffScopeSvc = new DiffScope();

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function detectBase(workspaceRoot: string): Promise<string | null> {
    return diffScopeSvc.detectBase(workspaceRoot);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function resolveBase(workspaceRoot: string): Promise<DiffRange> {
    return diffScopeSvc.resolveBase(workspaceRoot);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function getChangedFiles(workspaceRoot: string, base: string, head?: string, opts?: ChangedFilesOptions): Promise<string[]> {
    return diffScopeSvc.getChangedFiles(workspaceRoot, base, head, opts);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): Promise<string> {
    return diffScopeSvc.getFileDiff(workspaceRoot, file, base, head);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function getChangedLineNumbers(diffContent: string): Set<number> {
    return diffScopeSvc.getChangedLineNumbers(diffContent);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
    return diffScopeSvc.findNewMethodSignaturesInDiff(diffContent);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function hasChangesInRange(startLine: number, endLine: number, changedLines: Set<number>): boolean {
    return diffScopeSvc.hasChangesInRange(startLine, endLine, changedLines);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function isNewOrModified(
    name: string,
    startLine: number,
    endLine: number,
    changedLines: Set<number>,
    newMethodNames: Set<string>,
): boolean {
    return diffScopeSvc.isNewOrModified(name, startLine, endLine, changedLines, newMethodNames);
}
