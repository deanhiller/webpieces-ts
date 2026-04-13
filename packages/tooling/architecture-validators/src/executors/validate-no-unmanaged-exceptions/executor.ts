/**
 * Validate No Unmanaged Exceptions Executor
 *
 * Validates that try/catch blocks are not used outside chokepoints.
 * Uses LINE-BASED detection (not method-based) for git diff filtering.
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * - try {                           — any try/catch block in non-test code
 *
 * ============================================================================
 * ALLOWED (skip — NOT violations)
 * ============================================================================
 *
 * - Test files (.spec.ts, .test.ts, __tests__/)
 * - Lines with // webpieces-disable no-unmanaged-exceptions -- [reason]
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - MODIFIED_CODE:  Flag try/catch on changed lines (lines in diff hunks)
 * - MODIFIED_FILES: Flag ALL try/catch in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-unmanaged-exceptions -- [your justification]
 *   try {
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type NoUnmanagedExceptionsMode = 'OFF' | 'MODIFIED_CODE' | 'MODIFIED_FILES';

export interface ValidateNoUnmanagedExceptionsOptions {
    mode?: NoUnmanagedExceptionsMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface ExecutorResult {
    success: boolean;
}

interface TryCatchViolation {
    file: string;
    line: number;
    context: string;
}

/**
 * Check if a file is a test file that should be skipped.
 */
function isTestFile(filePath: string): boolean {
    return filePath.includes('.spec.ts') ||
        filePath.includes('.test.ts') ||
        filePath.includes('__tests__/');
}

/**
 * Get changed TypeScript files between base and head (or working tree if head not specified).
 * Excludes test files.
 */
// webpieces-disable max-lines-new-methods -- Git command handling with untracked files requires multiple code paths
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f) => f && !isTestFile(f));

        if (!head) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const untrackedOutput = execSync(`git ls-files --others --exclude-standard '*.ts' '*.tsx'`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                });
                const untrackedFiles = untrackedOutput
                    .trim()
                    .split('\n')
                    .filter((f) => f && !isTestFile(f));
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
            } catch {
                return changedFiles;
            }
        }

        return changedFiles;
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
    } catch {
        return [];
    }
}

/**
 * Get the diff content for a specific file.
 */
function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
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
                    const lines = content.split('\n');
                    return lines.map((line) => `+${line}`).join('\n');
                }
            }
        }

        return diff;
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
    } catch {
        return '';
    }
}

/**
 * Parse diff to extract changed line numbers (additions only - lines starting with +).
 */
function getChangedLineNumbers(diffContent: string): Set<number> {
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
            // Deletions don't increment line number
        } else {
            currentLine++;
        }
    }

    return changedLines;
}

/**
 * Check if a line contains a disable comment for no-unmanaged-exceptions.
 * Recognizes both webpieces-disable and eslint-disable-next-line @webpieces/ formats.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('no-unmanaged-exceptions')) {
            return true;
        }
        if (line.includes('@webpieces/no-unmanaged-exceptions')) {
            return true;
        }
    }
    return false;
}

const TRY_PATTERN = /\btry\s*\{/;

interface TryCatchInfo {
    line: number;
    context: string;
    hasDisableComment: boolean;
}

/**
 * Find all try/catch patterns in a file using line-based scanning.
 */
function findTryCatchInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean): TryCatchInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const violations: TryCatchInfo[] = [];

    for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i];
        const trimmed = line.trim();
        // Skip comment lines (JSDoc, block comments, line comments)
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        if (!TRY_PATTERN.test(line)) continue;

        const lineNum = i + 1;
        const disabled = hasDisableComment(fileLines, lineNum);

        if (!disableAllowed && disabled) {
            violations.push({ line: lineNum, context: line.trim(), hasDisableComment: false });
        } else {
            violations.push({ line: lineNum, context: line.trim(), hasDisableComment: disabled });
        }
    }

    return violations;
}

/**
 * MODIFIED_CODE mode: Flag violations on changed lines in diff hunks.
 */
function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean,
): TryCatchViolation[] {
    const violations: TryCatchViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findTryCatchInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;

            violations.push({ file, line: v.line, context: v.context });
        }
    }

    return violations;
}

/**
 * MODIFIED_FILES mode: Flag ALL violations in files that were modified.
 */
function findViolationsForModifiedFiles(
    workspaceRoot: string,
    changedFiles: string[],
    disableAllowed: boolean,
): TryCatchViolation[] {
    const violations: TryCatchViolation[] = [];

    for (const file of changedFiles) {
        const allViolations = findTryCatchInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            violations.push({ file, line: v.line, context: v.context });
        }
    }

    return violations;
}

/**
 * Auto-detect the base branch by finding the merge-base with origin/main.
 */
function detectBase(workspaceRoot: string): string | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
    } catch {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (mergeBase) {
                return mergeBase;
            }
        // webpieces-disable catch-error-pattern -- intentional swallow of git command failure
        } catch {
            // Ignore
        }
    }
    return null;
}

/**
 * Report violations to console.
 */
function reportViolations(violations: TryCatchViolation[], mode: NoUnmanagedExceptionsMode, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c Unmanaged try/catch blocks found! Exceptions should bubble to chokepoints.');
    console.error('');
    console.error('\ud83d\udcda Philosophy: Most code should NOT catch exceptions.');
    console.error('   Exceptions should bubble to chokepoints (filter in Node.js, globalErrorHandler in Angular)');
    console.error('   where they are logged with traceId for debugging.');
    console.error('');

    for (const v of violations) {
        console.error(`  \u274c ${v.file}:${v.line}`);
        console.error(`     ${v.context}`);
    }
    console.error('');

    if (disableAllowed) {
        console.error('   Escape hatch (use sparingly):');
        console.error('   // webpieces-disable no-unmanaged-exceptions -- [your reason]');
        console.error('');
        console.error('   When try/catch IS used, the catch block MUST follow:');
        console.error('   catch (err: unknown) { const error = toError(err); ... }');
        console.error('   or: catch (err: unknown) { //const error = toError(err); }');
    } else {
        console.error('   Escape hatch: DISABLED (disableAllowed: false)');
        console.error('   Disable comments are ignored. Remove the try/catch.');
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

/**
 * Resolve mode considering ignoreModifiedUntilEpoch override.
 */
function resolveMode(normalMode: NoUnmanagedExceptionsMode, epoch: number | undefined): NoUnmanagedExceptionsMode {
    if (epoch === undefined || normalMode === 'OFF') {
        return normalMode;
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
        console.log(`\n\u23ed\ufe0f  Skipping no-unmanaged-exceptions validation (ignoreModifiedUntilEpoch active, expires: ${expiresDate})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

export default async function runExecutor(
    options: ValidateNoUnmanagedExceptionsOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: NoUnmanagedExceptionsMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping no-unmanaged-exceptions validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n\ud83d\udccf Validating No Unmanaged Exceptions\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping no-unmanaged-exceptions validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('\u2705 No TypeScript files changed');
        return { success: true };
    }

    console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

    let violations: TryCatchViolation[] = [];

    if (mode === 'MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No unmanaged try/catch blocks found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);

    return { success: false };
}
