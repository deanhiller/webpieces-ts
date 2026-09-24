/**
 * Shared git-diff + diff-scoping service for ALL rule validators (code-rules) and nx executors
 * (nx-webpieces-rules). Centralized here in rules-config because it is the one package both depend on.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it can be injected and appear in the rules-config DI design. Free-function
 * delegators are kept temporarily so the many existing consumers stay green; they migrate to injecting
 * {@link DiffScope} over follow-up PRs, then the delegators are removed.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { FileScope, ScopedFileSelector } from './file-scope';
import { toError } from './to-error';

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
    /**
     * The {@link FileScope} the current async call chain runs inside. AsyncLocalStorage rather than a
     * field, because the free-function delegators below and every injected instance must see the SAME
     * scope, and because the scope must never leak past the one rule run that set it.
     */
    private static readonly active = new AsyncLocalStorage<FileScope>();

    /**
     * Run `work` with every getChangedFiles / getFileDiff call inside it answering for `scope` — the
     * one switch the whole-scope modes (#1027) and the debug run's `--projects` are built on.
     */
    within<T>(scope: FileScope, work: () => Promise<T>): Promise<T> {
        return DiffScope.active.run(scope, work);
    }

    /** The scope the caller is running inside; plain DIFF outside any {@link within}. */
    currentScope(): FileScope {
        return DiffScope.active.getStore() ?? FileScope.DIFF;
    }

    /**
     * Auto-detect the diff base: merge-base of HEAD with origin/main, falling back to local main. Under
     * RUN_EVERY_TIME the base is irrelevant to the file set, so an undetectable one falls back to HEAD
     * rather than making the rule skip.
     */
    detectBase(workspaceRoot: string): string | null {
        const detected = this.detectMergeBase(workspaceRoot);
        if (detected === null && this.currentScope().kind === 'RUN_EVERY_TIME') return 'HEAD';
        return detected;
    }

    private detectMergeBase(workspaceRoot: string): string | null {
        for (const ref of ['origin/main', 'main']) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const merged = execSync(`git merge-base HEAD ${ref}`, {
                    cwd: workspaceRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                }).trim();
                if (merged) return merged;
            } catch (err: unknown) {
                const error = toError(err);
                void error; // swallow — try the next ref
            }
        }
        return null;
    }

    /** Resolve the diff range a rule should compare against (honors nx's NX_BASE / NX_HEAD). */
    resolveBase(workspaceRoot: string): DiffRange {
        const range = new DiffRange();
        range.base = process.env['NX_BASE'];
        range.head = process.env['NX_HEAD'];
        if (!range.base) {
            range.base = this.detectBase(workspaceRoot) ?? undefined;
        }
        return range;
    }

    /**
     * The files a rule judges. Outside any {@link within} (and for the gate's plain diff scope) these are
     * the changed files between base and head (or base→working-tree when head is omitted), untracked
     * files unioned in for the working-tree case. Inside a widened {@link FileScope} they are the files
     * that scope selects — see file-scope.ts. `tsOnly` (default true) restricts to *.ts/*.tsx and drops
     * test files, in every scope. Deletions are excluded (`--diff-filter=d`).
     */
    getChangedFiles(workspaceRoot: string, base: string, head?: string, opts?: ChangedFilesOptions): string[] {
        const scope = this.currentScope();
        const diffFiles = this.diffFiles(workspaceRoot, base, head, opts);
        if (scope.isPlainDiff()) return diffFiles;
        const tsOnly = opts?.tsOnly ?? true;
        return new ScopedFileSelector().select(
            workspaceRoot,
            scope,
            diffFiles,
            () => this.diffFiles(workspaceRoot, base, head, this.everyChangedFile()),
            tsOnly ? ['*.ts', '*.tsx'] : [],
            (f: string) => !tsOnly || !this.isTestFile(f),
        );
    }

    // "Which projects did the diff touch" counts ANY changed file — a project.json, a README — not only
    // the files the rule itself judges.
    private everyChangedFile(): ChangedFilesOptions {
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        return opts;
    }

    // webpieces-disable max-lines-new-methods -- git command handling with untracked files needs several code paths
    private diffFiles(workspaceRoot: string, base: string, head?: string, opts?: ChangedFilesOptions): string[] {
        const tsOnly = opts?.tsOnly ?? true;
        const glob = tsOnly ? " -- '*.ts' '*.tsx'" : '';
        const keep = (f: string): boolean => f.length > 0 && (!tsOnly || !this.isTestFile(f));
        // Deletions are excluded by default (see ChangedFilesOptions.includeDeletions) — the review flow
        // opts in, every lint validator keeps the historical filter.
        const filter = opts?.includeDeletions === true ? '' : ' --diff-filter=d';
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const diffTarget = head ? `${base} ${head}` : base;
            const output = execSync(`git diff --name-only${filter} ${diffTarget}${glob}`, {
                cwd: workspaceRoot,
                encoding: 'utf-8',
            });
            const changedFiles = output.trim().split('\n').filter(keep);

            // Working-tree comparison (no head): also include untracked files, as nx affected does.
            if (!head) {
                // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
                try {
                    const untrackedOutput = execSync(`git ls-files --others --exclude-standard${glob}`, {
                        cwd: workspaceRoot,
                        encoding: 'utf-8',
                    });
                    const untrackedFiles = untrackedOutput.trim().split('\n').filter(keep);
                    return Array.from(new Set([...changedFiles, ...untrackedFiles]));
                } catch (err: unknown) {
                    const error = toError(err);
                    void error; // swallow — ls-files failure falls back to the tracked list
                    return changedFiles;
                }
            }

            return changedFiles;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // swallow — git diff failure returns an empty list
            return [];
        }
    }

    /**
     * Diff content for a single file (synthetic all-added diff for an untracked file with no head). Inside
     * a whole-scope {@link FileScope} every file is judged WHOLE, so the diff is the synthetic all-added
     * one for every file — a line- or method-scoped rule then sees the entire file as new.
     */
    getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
        if (this.currentScope().isWhole()) return this.allAddedDiff(workspaceRoot, file);
        return this.realFileDiff(workspaceRoot, file, base, head);
    }

    private allAddedDiff(workspaceRoot: string, file: string): string {
        const fullPath = path.join(workspaceRoot, file);
        if (!fs.existsSync(fullPath)) return '';
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        // A real hunk header, so getChangedLineNumbers numbers the lines from 1 like any git diff.
        return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l: string) => `+${l}`)].join('\n');
    }

    private realFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const diffTarget = head ? `${base} ${head}` : base;
            const diff = execSync(`git diff ${diffTarget} -- "${file}"`, {
                cwd: workspaceRoot,
                encoding: 'utf-8',
            });

            if (!diff && !head) {
                const fullPath = path.join(workspaceRoot, file);
                if (fs.existsSync(fullPath)) {
                    const isUntracked = execSync(`git ls-files --others --exclude-standard "${file}"`, {
                        cwd: workspaceRoot,
                        encoding: 'utf-8',
                    }).trim();

                    if (isUntracked) {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        return content.split('\n').map((l: string) => `+${l}`).join('\n');
                    }
                }
            }

            return diff;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // swallow — git diff failure returns no diff
            return '';
        }
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
export function detectBase(workspaceRoot: string): string | null {
    return diffScopeSvc.detectBase(workspaceRoot);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function resolveBase(workspaceRoot: string): DiffRange {
    return diffScopeSvc.resolveBase(workspaceRoot);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function getChangedFiles(workspaceRoot: string, base: string, head?: string, opts?: ChangedFilesOptions): string[] {
    return diffScopeSvc.getChangedFiles(workspaceRoot, base, head, opts);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to DiffScope; removed once consumers inject it
export function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
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
