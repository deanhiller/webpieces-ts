/**
 * Shared git-diff + diff-scoping helpers for ALL rule validators (code-rules) and nx executors
 * (nx-webpieces-rules). Centralized here in rules-config because it is the one package both of
 * those depend on, and it already shells out to git (see skip-rule.ts).
 *
 * Before this module these functions were copy-pasted ~15× (one private copy per validator + the
 * validate-ts-in-src executor). They are now defined once; every consumer imports from
 * `@webpieces/rules-config`. The two historical variants are preserved as parameters:
 *   - `getChangedFiles(..., { tsOnly: false })` reproduces validate-dtos' all-files diff.
 *   - `detectBase` replaces both the nested-try and the ref-loop spellings (identical behavior).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { toError } from './to-error';

/** A git diff range: the base ref to compare against and an optional head (else the working tree). */
export class DiffRange {
    base?: string;
    head?: string;
}

/** Options for getChangedFiles. `tsOnly` (default true) restricts to *.ts/*.tsx and drops test files. */
export class ChangedFilesOptions {
    tsOnly?: boolean;
}

/**
 * A file is "a test file" (excluded from diff-scoped rules) when it is a .spec/.test file or lives
 * under a __tests__/ directory. Union of every per-validator filter so no consumer loses coverage.
 */
function isTestFile(file: string): boolean {
    return file.includes('.spec.ts') || file.includes('.test.ts') || file.includes('__tests__/');
}

/**
 * Auto-detect the diff base: the merge-base of HEAD with origin/main, falling back to local main.
 * Returns null when neither ref resolves (e.g. shallow clone with no main) — callers treat null as
 * "no base detected" and typically skip.
 */
export function detectBase(workspaceRoot: string): string | null {
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

/**
 * Resolve the diff range a rule should compare against. Honors nx's NX_BASE / NX_HEAD (set by
 * `nx affected --base=.. --head=..`); when NX_BASE is unset, auto-detects via detectBase. A returned
 * `base` of undefined means "could not determine a base" (caller should skip).
 */
export function resolveBase(workspaceRoot: string): DiffRange {
    const range = new DiffRange();
    range.base = process.env['NX_BASE'];
    range.head = process.env['NX_HEAD'];
    if (!range.base) {
        range.base = detectBase(workspaceRoot) ?? undefined;
    }
    return range;
}

/**
 * Changed files between base and head (or base→working-tree when head is omitted). When head is
 * omitted, untracked files are unioned in too (matching `nx affected`). `tsOnly` (default true)
 * restricts to *.ts/*.tsx and drops test files; pass false for an all-files diff.
 */
// webpieces-disable max-lines-new-methods -- git command handling with untracked files needs several code paths
export function getChangedFiles(
    workspaceRoot: string,
    base: string,
    head?: string,
    opts?: ChangedFilesOptions,
): string[] {
    const tsOnly = opts?.tsOnly ?? true;
    const glob = tsOnly ? " -- '*.ts' '*.tsx'" : '';
    const keep = (f: string): boolean => f.length > 0 && (!tsOnly || !isTestFile(f));
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget}${glob}`, {
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
 * Diff content for a single file. When the file is untracked (and no head is given) a synthetic
 * all-added diff is produced so new files count as fully-changed.
 */
export function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
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

/**
 * Parse a unified diff and return the set of added/changed line numbers (the `+` lines per hunk).
 * This is the basis of NEW_AND_MODIFIED_CODE (line-level) scoping.
 */
export function getChangedLineNumbers(diffContent: string): Set<number> {
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

/**
 * Method names whose signature line is a `+` addition in the diff — the basis of "NEW" methods.
 */
export function findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
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

/**
 * True if any line in [startLine, endLine] is in the changedLines set.
 */
export function hasChangesInRange(startLine: number, endLine: number, changedLines: Set<number>): boolean {
    for (let line = startLine; line <= endLine; line++) {
        if (changedLines.has(line)) {
            return true;
        }
    }
    return false;
}

/**
 * True if a node (method/function) is newly added or has any changed line in its range.
 */
export function isNewOrModified(
    name: string,
    startLine: number,
    endLine: number,
    changedLines: Set<number>,
    newMethodNames: Set<string>,
): boolean {
    if (newMethodNames.has(name)) return true;
    return hasChangesInRange(startLine, endLine, changedLines);
}
