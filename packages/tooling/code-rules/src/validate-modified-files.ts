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

import * as fs from 'fs';
import * as path from 'path';
import { writeTemplate, hasDisable, RULE_NAMES, MaxFileLinesConfig, FileLimitMode, detectBase, getChangedFiles, isPathExcluded, GENERATED_CODE_PATHS, RuleFailError, Option } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { injectable, bindingScopeValues } from 'inversify';
import { shouldSkipRule, SkipRuleResult } from './resolve-mode';

/** One over-limit file. A class, not an interface — findViolations is exported for its tests. */
export class FileViolation {
    readonly file: string;
    readonly lines: number;
    readonly expiredDisable: boolean;
    readonly expiredDate: string | undefined;

    constructor(file: string, lines: number, expiredDisable = false, expiredDate?: string) {
        this.file = file;
        this.lines = lines;
        this.expiredDisable = expiredDisable;
        this.expiredDate = expiredDate;
    }
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
        if (hasDisable(line, RULE_NAMES.MAX_LINES_MODIFIED_FILES)) {
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
 * The complete exempt-path list for one run: the machine-generated trees that are exempt with no
 * configuration at all, PLUS whatever the repo listed in `max-file-lines.allowedPaths`. The config
 * ADDS to the floor rather than replacing it, so exempting one of your own trees can never silently
 * cost you the generated-code exemption (see GENERATED_CODE_PATHS for why that matters).
 */
// webpieces-disable no-function-outside-class -- pure list join, sibling of the file-scoped helpers here
export function exemptPathsFor(config: MaxFileLinesConfig): readonly string[] {
    return [...GENERATED_CODE_PATHS, ...(config.allowedPaths ?? [])];
}

/**
 * Count lines in a file and check for violations
 */
// webpieces-disable max-lines-new-methods -- File iteration with disable checking logic
// webpieces-disable no-function-outside-class -- pure scan over (files, limit, exemptPaths), sibling of the file-scoped helpers here
export function findViolations(workspaceRoot: string, changedFiles: string[], limit: number, disableAllowed: boolean, exemptPaths: readonly string[]): FileViolation[] {
    const violations: FileViolation[] = [];

    for (const file of changedFiles) {
        const fullPath = path.join(workspaceRoot, file);

        // Machine-generated / explicitly allowed trees: the file's size is not the repo's to fix.
        if (isPathExcluded(file, exemptPaths)) continue;

        if (!fs.existsSync(fullPath)) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lineCount = content.split('\n').length;

        // Skip files under the limit
        if (lineCount <= limit) continue;

        // When disableAllowed is false, ignore all disable comments
        if (!disableAllowed) {
            violations.push(new FileViolation(file, lineCount));
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
                violations.push(new FileViolation(file, lineCount, true, disableStatus.date));
                continue;
            }

            // Invalid disable (missing/bad date) - fall through to report as violation
        }

        violations.push(new FileViolation(file, lineCount));
    }

    return violations;
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
 * The ONE failure value for this rule: a `RuleFailError` carrying the prose for a human and the cures
 * as `Option[]`, which {@link RuleReporter} renders (it owns the "Fix Option N:" / "(preferred)"
 * labels, so nothing here hand-numbers a cure). This used to be a `console.error` paragraph beside a
 * `{ success: false }` return — a second spelling of "this validator failed" that the edit-time half of
 * the SAME rule never used.
 */
// webpieces-disable max-lines-new-methods -- one message value assembled from several sections
// webpieces-disable no-function-outside-class -- pure value builder, sibling of the file-scoped helpers here
export function violationsError(violations: readonly FileViolation[], limit: number, disableAllowed: boolean): RuleFailError {
    const listed = violations.map((v: FileViolation): string => v.expiredDisable
        ? `  ${v.file} (${v.lines} lines, max: ${limit})\n     EXPIRED DISABLE: the disable comment dated ${v.expiredDate ?? '?'} is over a month old — FIX the file or update the date for another month.`
        : `  ${v.file} (${v.lines} lines, max: ${limit})`).join('\n');

    const message = [
        `YOU MUST FIX THIS AND NOT be more than ${limit} lines of code per file — it slows down IDEs and is VERY VERY EASY to refactor.`,
        '',
        'With stateless systems + dependency injection, refactor is trivial: pick a method or a few and',
        'move them to a new class XXXXX, inject XXXXX into all users of those methods via the constructor,',
        `then delete those methods from the original class. 99% of files can be less than ${limit} lines.`,
        '',
        listed,
        '',
        `disableAllowed is ${disableAllowed}${disableAllowed ? '' : ' — inline disable comments are IGNORED for this rule'}.`,
    ].join('\n');

    const cures: Option[] = [
        new Option(`Refactor the file under ${limit} lines — READ .webpieces/instruct-ai/${TMP_MD_FILE} for step-by-step guidance.`, true),
        new Option('Is the file MACHINE-GENERATED (codegen output, a schema dump)? Its size is not yours to fix, and turning the rule off is the wrong cure — that stops it on hand-written files too. Add its tree to rules."max-file-lines".allowedPaths in webpieces.config.json, e.g. "allowedPaths": ["**/__generated__/**"]. Never list hand-written code there.'),
    ];
    if (disableAllowed) {
        cures.push(new Option(`Put this on the FIRST 5 lines of the file (it expires in 1 month): // webpieces-disable max-lines-modified-files ${getTodayDateString()} -- [your reason]`));
    } else {
        cures.push(new Option('For a major refactor a HUMAN — never an AI agent — can set "turnOffRuleUntilEpoch" (an expiry, in epoch seconds) on the max-file-lines entry in webpieces.config.json, so files may expand during the refactor and each PR shrinks them as it touches them.'));
    }

    return new RuleFailError('max-file-lines', message, undefined, undefined, cures);
}

async function runValidatorImpl(
    options: MaxFileLinesConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const limit = options.limit ?? 900;
    const disableAllowed = options.disableAllowed ?? true;
    // Machine-generated trees + the repo's own allowedPaths. A line-count rule firing on a file nobody
    // authored is never a useful signal, so the generated half needs no configuration.
    const exemptPaths = exemptPathsFor(options);

    const rawMode: FileLimitMode = options.mode ?? 'NEW_AND_MODIFIED_FILES';
    const skip = rawMode !== 'OFF' ? shouldSkipRule(options.turnOffRuleUntilEpoch, (options.turnOffRuleWhileOnBranch ?? undefined)) : new SkipRuleResult(false);
    const mode: FileLimitMode = skip.skip ? 'OFF' : rawMode;

    // Skip validation entirely if mode is OFF
    if (mode === 'OFF') {
        const reason = skip.skip ? skip.reason : 'mode: OFF';
        console.log(`\n\u23ed\ufe0f  Skipping modified files validation (${reason})`);
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
    console.log(`   Exempt paths: ${exemptPaths.join(', ')}`);
    console.log('');

    let violations: FileViolation[];

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const changedFiles = getChangedFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('\u2705 No TypeScript files changed');
            return { success: true };
        }

        console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

        violations = findViolations(workspaceRoot, changedFiles, limit, disableAllowed, exemptPaths);
    } catch (err: unknown) {
        //const error = toError(err);
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('\u274c Modified files validation failed:', error.message);
        return { success: false };
    }

    if (violations.length === 0) {
        console.log('\u2705 All modified files are under ' + limit + ' lines');
        return { success: true };
    }

    // The ONE failure path: throw, so RuleReporter renders the message and its cures for this audience.
    writeTmpInstructions(workspaceRoot);
    throw violationsError(violations, limit, disableAllowed);
}

@injectable(bindingScopeValues.Singleton)
export class MaxFileLinesValidator extends CodeValidator<MaxFileLinesConfig> {
    constructor(config: MaxFileLinesConfig) {
        super(config, 'max-file-lines', 'max-file-lines');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
