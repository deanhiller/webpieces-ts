/**
 * Validate Modified Methods Executor
 *
 * Validates that modified methods don't exceed a maximum line count (default 80).
 * This encourages gradual cleanup of legacy long methods - when you touch a method,
 * you must bring it under the limit.
 *
 * Combined with validate-new-methods, this creates a gradual
 * transition to cleaner code:
 * - New methods: must be under limit
 * - Modified methods: must be under limit (cleanup when touched)
 * - Untouched methods: no limit (legacy allowed)
 *
 * Usage:
 * nx affected --target=validate-modified-methods --base=origin/main
 *
 * Escape hatch: Add webpieces-disable max-lines-modified comment with date and justification
 * Format: // webpieces-disable max-lines-modified 2025/01/15 -- [reason]
 * The disable expires after 1 month from the date specified.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    writeTemplate,
    RULE_NAMES,
    WEBPIECES_DISABLE,
    MaxMethodLinesConfig,
    MethodLimitMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
    findNewMethodSignaturesInDiff,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';
import { runNewMethods } from './validate-new-methods';

interface MethodViolation {
    file: string;
    methodName: string;
    line: number;
    lines: number;
    expiredDisable?: boolean;
    expiredDate?: string;
}

const TMP_MD_FILE = 'webpieces.methodsize.md';

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

interface DisableInfo {
    type: 'full' | 'new-only' | 'none';
    isExpired: boolean;
    date?: string;
}

/**
 * Check what kind of webpieces-disable comment is present for a method.
 * Returns: DisableInfo with type, expiration status, and date
 * - 'full': max-lines-modified (ultimate escape, skips both validators)
 * - 'new-only': max-lines-new-methods (escaped 30-line check, still needs 80-line check)
 * - 'none': no escape hatch
 */
// webpieces-disable max-lines-new-methods -- Complex validation logic with multiple escape hatch types
function getDisableInfo(lines: string[], lineNumber: number): DisableInfo {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes(WEBPIECES_DISABLE)) {
            if (line.includes(RULE_NAMES.MAX_LINES_MODIFIED)) {
                // Check for date in format: max-lines-modified yyyy/mm/dd
                const dateMatch = line.match(/max-lines-modified\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);

                if (!dateMatch) {
                    // No date found - treat as expired (invalid)
                    return { type: 'full', isExpired: true, date: undefined };
                }

                const dateStr = dateMatch[1];

                // Secret permanent disable
                if (dateStr === 'XXXX/XX/XX') {
                    return { type: 'full', isExpired: false, date: dateStr };
                }

                const date = parseDisableDate(dateStr);
                if (!date) {
                    // Invalid date format - treat as expired
                    return { type: 'full', isExpired: true, date: dateStr };
                }

                if (!isDateWithinMonth(date)) {
                    // Date is expired (older than 1 month)
                    return { type: 'full', isExpired: true, date: dateStr };
                }

                // Valid and not expired
                return { type: 'full', isExpired: false, date: dateStr };
            }
            if (line.includes(RULE_NAMES.MAX_LINES_NEW_METHODS)) {
                // Check for date in format: max-lines-new-methods yyyy/mm/dd
                const dateMatch = line.match(/max-lines-new-methods\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);

                if (!dateMatch) {
                    // No date found - treat as expired (invalid)
                    return { type: 'new-only', isExpired: true, date: undefined };
                }

                const dateStr = dateMatch[1];

                // Secret permanent disable
                if (dateStr === 'XXXX/XX/XX') {
                    return { type: 'new-only', isExpired: false, date: dateStr };
                }

                const date = parseDisableDate(dateStr);
                if (!date) {
                    // Invalid date format - treat as expired
                    return { type: 'new-only', isExpired: true, date: dateStr };
                }

                if (!isDateWithinMonth(date)) {
                    // Date is expired (older than 1 month)
                    return { type: 'new-only', isExpired: true, date: dateStr };
                }

                // Valid and not expired
                return { type: 'new-only', isExpired: false, date: dateStr };
            }
        }
    }
    return { type: 'none', isExpired: false };
}

interface MethodInfo {
    name: string;
    line: number;
    endLine: number;
    lines: number;
    disableInfo: DisableInfo;
}

/**
 * Parse a TypeScript file and find methods with their line counts
 */
// webpieces-disable max-lines-new-methods -- AST traversal requires inline visitor function
function findMethodsInFile(filePath: string, workspaceRoot: string): MethodInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const methods: MethodInfo[] = [];

    // webpieces-disable max-lines-new-methods -- AST visitor pattern requires handling multiple node types
    function visit(node: ts.Node): void {
        let methodName: string | undefined;
        let startLine: number | undefined;
        let endLine: number | undefined;

        if (ts.isMethodDeclaration(node) && node.name) {
            methodName = node.name.getText(sourceFile);
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            startLine = start.line + 1;
            endLine = end.line + 1;
        } else if (ts.isFunctionDeclaration(node) && node.name) {
            methodName = node.name.getText(sourceFile);
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            startLine = start.line + 1;
            endLine = end.line + 1;
        } else if (ts.isArrowFunction(node)) {
            if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
                methodName = node.parent.name.getText(sourceFile);
                const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
                startLine = start.line + 1;
                endLine = end.line + 1;
            }
        }

        if (methodName && startLine !== undefined && endLine !== undefined) {
            methods.push({
                name: methodName,
                line: startLine,
                endLine: endLine,
                lines: endLine - startLine + 1,
                disableInfo: getDisableInfo(fileLines, startLine),
            });
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return methods;
}

/**
 * Check if a method has any changes within its line range
 */
function methodHasChanges(method: MethodInfo, changedLineNumbers: Set<number>): boolean {
    for (let line = method.line; line <= method.endLine; line++) {
        if (changedLineNumbers.has(line)) return true;
    }
    return false;
}

/**
 * Check a NEW method and return violation if applicable
 */
function checkNewMethodViolation(file: string, method: MethodInfo, disableAllowed: boolean): MethodViolation | null {
    const disableType = method.disableInfo.type;
    const isExpired = method.disableInfo.isExpired;
    const disableDate = method.disableInfo.date;

    if (!disableAllowed) {
        // When disableAllowed is false, skip NEW methods without escape (let validate-new-methods handle)
        if (disableType === 'none') return null;
        return { file, methodName: method.name, line: method.line, lines: method.lines };
    }

    if (disableType === 'full' && isExpired) {
        return { file, methodName: method.name, line: method.line, lines: method.lines, expiredDisable: true, expiredDate: disableDate };
    }
    if (disableType !== 'new-only') return null;

    if (isExpired) {
        return { file, methodName: method.name, line: method.line, lines: method.lines, expiredDisable: true, expiredDate: disableDate };
    }
    return { file, methodName: method.name, line: method.line, lines: method.lines };
}

/**
 * Check a MODIFIED method and return violation if applicable
 */
function checkModifiedMethodViolation(file: string, method: MethodInfo, disableAllowed: boolean): MethodViolation | null {
    const disableType = method.disableInfo.type;
    const isExpired = method.disableInfo.isExpired;
    const disableDate = method.disableInfo.date;

    if (!disableAllowed) {
        return { file, methodName: method.name, line: method.line, lines: method.lines };
    }
    if (disableType === 'full' && !isExpired) {
        // Valid escape, no violation
        return null;
    }
    if (disableType === 'full' && isExpired) {
        return { file, methodName: method.name, line: method.line, lines: method.lines, expiredDisable: true, expiredDate: disableDate };
    }
    return { file, methodName: method.name, line: method.line, lines: method.lines };
}

/**
 * Find methods that exceed the limit.
 * Checks NEW methods with escape hatches and MODIFIED methods.
 */
function findViolations(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    limit: number,
    disableAllowed: boolean,
    head?: string
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        if (!diff) continue;

        const newMethodNames = findNewMethodSignaturesInDiff(diff);
        const changedLineNumbers = getChangedLineNumbers(diff);
        if (changedLineNumbers.size === 0) continue;

        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            const disableType = method.disableInfo.type;
            const isExpired = method.disableInfo.isExpired;

            // Skip methods with valid, non-expired full escape - unless disableAllowed is false
            if (disableAllowed && disableType === 'full' && !isExpired) continue;
            if (method.lines <= limit) continue;

            const isNewMethod = newMethodNames.has(method.name);

            if (isNewMethod) {
                const violation = checkNewMethodViolation(file, method, disableAllowed);
                if (violation) violations.push(violation);
            } else if (methodHasChanges(method, changedLineNumbers)) {
                const violation = checkModifiedMethodViolation(file, method, disableAllowed);
                if (violation) violations.push(violation);
            }
        }
    }

    return violations;
}

/**
 * Report violations to console
 */
// webpieces-disable max-lines-new-methods -- Error output formatting with multiple message sections
function reportViolations(violations: MethodViolation[], limit: number, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c Modified methods exceed ' + limit + ' lines!');
    console.error('');
    console.error('\ud83d\udcda When you modify a method, you must bring it under ' + limit + ' lines.');
    console.error('   This rule encourages GRADUAL cleanup so even though you did not cause it,');
    console.error('   you touched it, so you should fix now as part of your PR');
    console.error('   (this is for vibe coding and AI to fix as it touches things).');
    console.error('   You can refactor to stay under the limit 50% of the time. If not feasible, use the escape hatch.');
    console.error('');
    console.error(
        '\u26a0\ufe0f  *** READ .webpieces/instruct-ai/webpieces.methodsize.md for detailed guidance on how to fix this easily *** \u26a0\ufe0f'
    );
    console.error('');

    for (const v of violations) {
        if (v.expiredDisable) {
            console.error(`  \u274c ${v.file}:${v.line}`);
            console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${limit})`);
            console.error(`     \u23f0 EXPIRED DISABLE: Your disable comment dated ${v.expiredDate ?? 'unknown'} has expired (>1 month old).`);
            console.error(`        You must either FIX the method or UPDATE the date to get another month.`);
        } else {
            console.error(`  \u274c ${v.file}:${v.line}`);
            console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${limit})`);
        }
    }
    console.error('');

    // Only show escape hatch instructions when disableAllowed is true
    if (disableAllowed) {
        console.error('   You can disable this error, but you will be forced to fix again in 1 month');
        console.error('   since 99% of methods can be less than ' + limit + ' lines of code.');
        console.error('');
        console.error('   Use escape with DATE (expires in 1 month):');
        console.error(`   // webpieces-disable max-lines-modified ${getTodayDateString()} -- [your reason]`);
        console.error('');
    } else {
        console.error('   \u26a0\ufe0f  disableAllowed is false - disable comments are NOT allowed.');
        console.error('   This rule must be met and cannot be disabled since nx.json disableAllowed is set to false.');
        console.error('   You MUST refactor to reduce method size.');
        console.error('');
        console.error('   For a major refactor, a human can add "ignoreModifiedUntilEpoch" to nx.json validate-code options.');
        console.error('   This is an expiry timestamp (epoch ms) for when we start forcing everyone to meet size rules again.');
        console.error('   Sometimes for speed, we allow methods to expand during a refactor and over time,');
        console.error('   each PR reduces methods as they get touched.');
        console.error('   AI agents should NOT add ignoreModifiedUntilEpoch - ask a human to do it.');
        console.error('');
    }
}

export async function runModifiedMethods(
    options: MaxMethodLinesConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const limit = options.limit ?? 80;
    const disableAllowed = options.disableAllowed ?? true;

    const rawMode: MethodLimitMode = options.mode ?? 'NEW_AND_MODIFIED_METHODS';
    const skip = rawMode !== 'OFF' ? shouldSkipRule(options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch) : { skip: false };
    const mode: MethodLimitMode = skip.skip ? 'OFF' : rawMode;

    // Skip validation entirely if mode is OFF
    if (mode === 'OFF') {
        const reason = skip.skip ? skip.reason : 'mode: OFF';
        console.log(`\n\u23ed\ufe0f  Skipping modified method validation (${reason})`);
        console.log('');
        return { success: true };
    }

    // If NX_HEAD is set (via nx affected --head=X), use it; otherwise compare to working tree
    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping modified method validation (could not detect base branch)');
            console.log('   To run explicitly: nx affected --target=validate-modified-methods --base=origin/main');
            console.log('');
            return { success: true };
        }

        console.log('\n\ud83d\udccf Validating Modified Method Sizes (auto-detected base)\n');
    } else {
        console.log('\n\ud83d\udccf Validating Modified Method Sizes\n');
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log(`   Mode: ${mode}`);
    console.log(`   Limit for modified methods: ${limit}`);
    console.log(`   Disable allowed: ${disableAllowed}${!disableAllowed ? ' (no escape hatch)' : ''}`);
    console.log('');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const changedFiles = getChangedFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('\u2705 No TypeScript files changed');
            return { success: true };
        }

        console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

        const violations = findViolations(workspaceRoot, changedFiles, base, limit, disableAllowed, head);

        if (violations.length === 0) {
            console.log('\u2705 All modified methods are under ' + limit + ' lines');
            return { success: true };
        }

        writeTmpInstructions(workspaceRoot);
        reportViolations(violations, limit, disableAllowed);
        return { success: false };
    } catch (err: unknown) {
        //const error = toError(err);
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('\u274c Modified method validation failed:', error.message);
        return { success: false };
    }
}

/**
 * MaxMethodLinesValidator — the single 'max-method-lines' validator.
 *
 * Reproduces the previous `runMethodValidators` orchestration: depending on the
 * configured mode it runs the new-methods sub-check and/or the modified-methods
 * sub-check.
 *   - NEW_METHODS                -> new-methods only
 *   - NEW_AND_MODIFIED_METHODS   -> new-methods + modified-methods
 *   - NEW_AND_MODIFIED_FILES             -> modified-methods only
 */
export class MaxMethodLinesValidator extends CodeValidator<MaxMethodLinesConfig> {
    constructor(config: MaxMethodLinesConfig) {
        super(config, 'max-method-lines');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode: MethodLimitMode = this.config.mode ?? 'NEW_AND_MODIFIED_METHODS';
        const runNew = mode === 'NEW_METHODS' || mode === 'NEW_AND_MODIFIED_METHODS';
        const runModified = mode === 'NEW_AND_MODIFIED_METHODS' || mode === 'NEW_AND_MODIFIED_FILES';

        const results: ExecutorResult[] = [];
        if (runNew) {
            results.push(await runNewMethods(this.config, workspaceRoot));
        }
        if (runModified) {
            results.push(await runModifiedMethods(this.config, workspaceRoot));
        }
        return { success: results.every((r) => r.success) };
    }
}
