/**
 * Validate Modified Files Executor
 *
 * Validates that modified files don't exceed a maximum line count (default 900).
 * This encourages keeping files small and focused - when you touch a file,
 * you must bring it under the limit.
 *
 * Usage:
 * nx affected --target=validate-modified-files --base=origin/main
 *
 * Escape hatch: Add webpieces-disable max-lines-modified-files comment with date and justification
 * Format: // webpieces-disable max-lines-modified-files 2025/01/15 -- [reason]
 * The disable expires after 1 month from the date specified.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeTemplate } from '@webpieces/rules-config';

export type FileMaxLimitMode = 'OFF' | 'MODIFIED_FILES';

export interface ValidateModifiedFilesOptions {
    limit?: number;
    mode?: FileMaxLimitMode;
    disableAllowed?: boolean;
}

export interface ExecutorResult {
    success: boolean;
}

interface FileViolation {
    file: string;
    lines: number;
    expiredDisable?: boolean;
    expiredDate?: string;
}

const TMP_MD_FILE = 'webpieces.filesize.md';


/**
 * Write the instructions documentation to .webpieces/instruct-ai/.
 * Sourced from @webpieces/rules-config.
 */
function writeTmpInstructions(workspaceRoot: string): string {
    return writeTemplate(workspaceRoot, TMP_MD_FILE);
}

/**
 * Get changed TypeScript files between base and head (or working tree if head not specified).
 * Uses `git diff base [head]` to match what `nx affected` does.
 * When head is NOT specified, also includes untracked files (matching nx affected behavior).
 */
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // If head is specified, diff base to head; otherwise diff base to working tree
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));

        // When comparing to working tree (no head specified), also include untracked files
        // This matches what nx affected does: "All modified files not yet committed or tracked will also be added"
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
                    .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));
                // Merge and dedupe
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            } catch (err: unknown) {
                //const error = toError(err);
                // If ls-files fails, just return the changed files
                return changedFiles;
            }
        }

        return changedFiles;
    } catch (err: unknown) {
        //const error = toError(err);
        return [];
    }
}

/**
 * Parse a date string in yyyy/mm/dd format and return a Date object.
 * Returns null if the format is invalid.
 */
function parseDisableDate(dateStr: string): Date | null {
    // Match yyyy/mm/dd format
    const match = dateStr.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!match) return null;

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
    const day = parseInt(match[3], 10);

    const date = new Date(year, month, day);

    // Validate the date is valid (e.g., not Feb 30)
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
        return null;
    }

    return date;
}

/**
 * Check if a date is within the last month (not expired).
 */
function isDateWithinMonth(date: Date): boolean {
    const now = new Date();
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    return date >= oneMonthAgo;
}

interface DisableStatus {
    hasDisable: boolean;
    isValid: boolean;
    isExpired: boolean;
    date?: string;
}

/**
 * Check if a file has a valid, non-expired disable comment at the top (within first 5 lines).
 * Returns status object with details about the disable comment.
 */
// webpieces-disable max-lines-new-methods -- Date validation logic requires checking multiple conditions
function checkDisableComment(content: string): DisableStatus {
    const lines = content.split('\n').slice(0, 5);

    for (const line of lines) {
        if (line.includes('webpieces-disable') && line.includes('max-lines-modified-files')) {
            // Found disable comment, now check for date
            // Format: // webpieces-disable max-lines-modified-files yyyy/mm/dd -- reason
            const dateMatch = line.match(/max-lines-modified-files\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);

            if (!dateMatch) {
                // No date found - invalid disable comment
                return { hasDisable: true, isValid: false, isExpired: false };
            }

            const dateStr = dateMatch[1];

            // Secret permanent disable
            if (dateStr === 'XXXX/XX/XX') {
                return { hasDisable: true, isValid: true, isExpired: false, date: dateStr };
            }

            const date = parseDisableDate(dateStr);
            if (!date) {
                // Invalid date format
                return { hasDisable: true, isValid: false, isExpired: false, date: dateStr };
            }

            if (!isDateWithinMonth(date)) {
                // Date is expired (older than 1 month)
                return { hasDisable: true, isValid: true, isExpired: true, date: dateStr };
            }

            // Valid and not expired
            return { hasDisable: true, isValid: true, isExpired: false, date: dateStr };
        }
    }

    return { hasDisable: false, isValid: false, isExpired: false };
}

/**
 * Count lines in a file and check for violations
 */
// webpieces-disable max-lines-new-methods -- File iteration with disable checking logic
function findViolations(workspaceRoot: string, changedFiles: string[], limit: number, disableAllowed: boolean): FileViolation[] {
    const violations: FileViolation[] = [];

    for (const file of changedFiles) {
        const fullPath = path.join(workspaceRoot, file);

        if (!fs.existsSync(fullPath)) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lineCount = content.split('\n').length;

        // Skip files under the limit
        if (lineCount <= limit) continue;

        // When disableAllowed is false, ignore all disable comments
        if (!disableAllowed) {
            violations.push({ file, lines: lineCount });
            continue;
        }

        // Check for disable comment
        const disableStatus = checkDisableComment(content);

        if (disableStatus.hasDisable) {
            if (disableStatus.isValid && !disableStatus.isExpired) {
                // Valid, non-expired disable - skip this file
                continue;
            }

            if (disableStatus.isExpired) {
                // Expired disable - report as violation with expired info
                violations.push({
                    file,
                    lines: lineCount,
                    expiredDisable: true,
                    expiredDate: disableStatus.date,
                });
                continue;
            }

            // Invalid disable (missing/bad date) - fall through to report as violation
        }

        violations.push({
            file,
            lines: lineCount,
        });
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
    } catch (err: unknown) {
        //const error = toError(err);
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
        } catch (err2: unknown) {
            //const error2 = toError(err2);
            // Ignore
        }
    }
    return null;
}

/**
 * Get today's date in yyyy/mm/dd format for error messages
 */
function getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
}

/**
 * Report violations to console
 */
// webpieces-disable max-lines-new-methods -- Error output formatting with multiple message sections
function reportViolations(violations: FileViolation[], limit: number, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c YOU MUST FIX THIS AND NOT be more than ' + limit + ' lines of code per file');
    console.error('   as it slows down IDEs AND is VERY VERY EASY to refactor.');
    console.error('');
    console.error('\ud83d\udcda With stateless systems + dependency injection, refactor is trivial:');
    console.error('   Pick a method or a few and move to new class XXXXX, then inject XXXXX');
    console.error('   into all users of those methods via the constructor.');
    console.error('   Delete those methods from original class.');
    console.error('   99% of files can be less than ' + limit + ' lines of code.');
    console.error('');
    console.error('\u26a0\ufe0f  *** READ .webpieces/instruct-ai/webpieces.filesize.md for detailed guidance on how to fix this easily *** \u26a0\ufe0f');
    console.error('');

    for (const v of violations) {
        if (v.expiredDisable) {
            console.error(`  \u274c ${v.file} (${v.lines} lines, max: ${limit})`);
            console.error(`     \u23f0 EXPIRED DISABLE: Your disable comment dated ${v.expiredDate} has expired (>1 month old).`);
            console.error(`        You must either FIX the file or UPDATE the date to get another month.`);
        } else {
            console.error(`  \u274c ${v.file} (${v.lines} lines, max: ${limit})`);
        }
    }
    console.error('');

    // Only show escape hatch instructions when disableAllowed is true
    if (disableAllowed) {
        console.error('   You can disable this error, but you will be forced to fix again in 1 month');
        console.error('   since 99% of files can be less than ' + limit + ' lines of code.');
        console.error('');
        console.error('   Use escape with DATE (expires in 1 month):');
        console.error(`   // webpieces-disable max-lines-modified-files ${getTodayDateString()} -- [your reason]`);
        console.error('');
    } else {
        console.error('   \u26a0\ufe0f  disableAllowed is false - disable comments are NOT allowed.');
        console.error('   This rule must be met and cannot be disabled since nx.json disableAllowed is set to false.');
        console.error('   You MUST refactor to reduce file size.');
        console.error('');
        console.error('   For a major refactor, a human can add "ignoreModifiedUntilEpoch" to nx.json validate-code options.');
        console.error('   This is an expiry timestamp (epoch ms) for when we start forcing everyone to meet size rules again.');
        console.error('   Sometimes for speed, we allow files to expand during a refactor and over time,');
        console.error('   each PR reduces files as they get touched.');
        console.error('   AI agents should NOT add ignoreModifiedUntilEpoch - ask a human to do it.');
        console.error('');
    }
}

export default async function runValidator(
    options: ValidateModifiedFilesOptions,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const limit = options.limit ?? 900;
    const mode: FileMaxLimitMode = options.mode ?? 'MODIFIED_FILES';
    const disableAllowed = options.disableAllowed ?? true;

    // Skip validation entirely if mode is OFF
    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping modified files validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    // If NX_HEAD is set (via nx affected --head=X), use it; otherwise compare to working tree
    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping modified files validation (could not detect base branch)');
            console.log('   To run explicitly: nx affected --target=validate-modified-files --base=origin/main');
            console.log('');
            return { success: true };
        }

        console.log('\n\ud83d\udccf Validating Modified File Sizes (auto-detected base)\n');
    } else {
        console.log('\n\ud83d\udccf Validating Modified File Sizes\n');
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log(`   Mode: ${mode}`);
    console.log(`   Max lines for modified files: ${limit}`);
    console.log(`   Disable allowed: ${disableAllowed}${!disableAllowed ? ' (no escape hatch)' : ''}`);
    console.log('');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('\u2705 No TypeScript files changed');
            return { success: true };
        }

        console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

        const violations = findViolations(workspaceRoot, changedFiles, limit, disableAllowed);

        if (violations.length === 0) {
            console.log('\u2705 All modified files are under ' + limit + ' lines');
            return { success: true };
        }

        writeTmpInstructions(workspaceRoot);
        reportViolations(violations, limit, disableAllowed);
        return { success: false };
    } catch (err: unknown) {
        //const error = toError(err);
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('\u274c Modified files validation failed:', error.message);
        return { success: false };
    }
}
