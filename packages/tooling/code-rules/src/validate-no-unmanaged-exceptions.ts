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
 * - NEW_AND_MODIFIED_CODE:  Flag try/catch on changed lines (lines in diff hunks)
 * - NEW_AND_MODIFIED_FILES: Flag ALL try/catch in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-unmanaged-exceptions -- [your justification]
 *   try {
 */

import * as fs from 'fs';
import * as path from 'path';
import { hasDisable, RULE_NAMES, NoUnmanagedExceptionsConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { provideSingleton } from '@webpieces/rules-config';
import { injectable } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

interface TryCatchViolation {
    file: string;
    line: number;
    context: string;
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
        if (hasDisable(line, RULE_NAMES.NO_UNMANAGED_EXCEPTIONS)) {
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
 * NEW_AND_MODIFIED_CODE mode: Flag violations on changed lines in diff hunks.
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
 * NEW_AND_MODIFIED_FILES mode: Flag ALL violations in files that were modified.
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
 * Report violations to console.
 */
function reportViolations(violations: TryCatchViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
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
function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n\u23ed\ufe0f  Skipping no-unmanaged-exceptions validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(
    options: NoUnmanagedExceptionsConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
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

    const changedFiles = getChangedFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('\u2705 No TypeScript files changed');
        return { success: true };
    }

    console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

    let violations: TryCatchViolation[] = [];

    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No unmanaged try/catch blocks found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);

    return { success: false };
}

@provideSingleton()
@injectable()
export class NoUnmanagedExceptionsValidator extends CodeValidator<NoUnmanagedExceptionsConfig> {
    constructor(config: NoUnmanagedExceptionsConfig) {
        super(config, 'no-unmanaged-exceptions');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
