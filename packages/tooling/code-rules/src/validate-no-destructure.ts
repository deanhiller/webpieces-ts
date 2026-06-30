/**
 * Validate No Destructure Executor
 *
 * Validates that destructuring patterns are not used in TypeScript code.
 * Uses LINE-BASED detection (not method-based) for git diff filtering.
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * - const { x, y } = obj          — object destructuring in variable declarations
 * - const [a, b] = fn()           — array destructuring (except Promise.all)
 * - for (const { email } of items) — object destructuring in for-of loops
 * - for (const [a, b] of items)   — array destructuring in for-of (except Object.entries)
 * - const { page = 0 } = opts     — destructuring with defaults
 * - const { done: streamDone } = obj — destructuring with renaming
 * - function foo({ x, y }: Type)  — function parameter destructuring
 *
 * ============================================================================
 * ALLOWED (skip — NOT violations)
 * ============================================================================
 *
 * - const [a, b] = await Promise.all([...]) — Promise.all array destructuring
 * - for (const [key, value] of Object.entries(obj)) — Object.entries in for-of
 * - const { extracted, ...rest } = obj — rest operator separation
 * - Lines with // webpieces-disable no-destructure -- [reason] (only when disableAllowed: true)
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - MODIFIED_CODE:  Flag destructuring on changed lines (lines in diff hunks)
 * - NEW_AND_MODIFIED_FILES: Flag ALL destructuring in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-destructure -- [your justification]
 *   const { x, y } = obj;
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { hasDisable, RULE_NAMES, NoDestructureConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

interface DestructureViolation {
    file: string;
    line: number;
    column: number;
    context: string;
}

/**
 * Check if a line contains a webpieces-disable comment for no-destructure.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (hasDisable(line, RULE_NAMES.NO_DESTRUCTURE)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if an ArrayBindingPattern's initializer is `await Promise.all(...)`.
 */
function isPromiseAllDestructure(node: ts.ArrayBindingPattern): boolean {
    const parent = node.parent;
    if (!ts.isVariableDeclaration(parent)) return false;
    const initializer = parent.initializer;
    if (!initializer) return false;

    // Handle: const [a, b] = await Promise.all([...])
    if (ts.isAwaitExpression(initializer)) {
        const awaitedExpr = initializer.expression;
        if (ts.isCallExpression(awaitedExpr)) {
            const callExpr = awaitedExpr.expression;
            // Promise.all(...)
            if (ts.isPropertyAccessExpression(callExpr) && callExpr.name.text === 'all') {
                const obj = callExpr.expression;
                if (ts.isIdentifier(obj) && obj.text === 'Promise') {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Check if an ArrayBindingPattern in a for-of loop iterates over Object.entries(...).
 */
function isObjectEntriesForOf(node: ts.ArrayBindingPattern): boolean {
    // Walk up: ArrayBindingPattern -> VariableDeclaration -> VariableDeclarationList -> ForOfStatement
    const varDecl = node.parent;
    if (!ts.isVariableDeclaration(varDecl)) return false;

    const varDeclList = varDecl.parent;
    if (!ts.isVariableDeclarationList(varDeclList)) return false;

    const forOfStmt = varDeclList.parent;
    if (!ts.isForOfStatement(forOfStmt)) return false;

    // Check iterable expression ends with .entries()
    const iterable = forOfStmt.expression;
    if (ts.isCallExpression(iterable)) {
        const callExpr = iterable.expression;
        if (ts.isPropertyAccessExpression(callExpr) && callExpr.name.text === 'entries') {
            return true;
        }
    }

    return false;
}

/**
 * Check if an ObjectBindingPattern contains a rest element (...rest).
 */
function hasRestElement(node: ts.ObjectBindingPattern): boolean {
    for (const element of node.elements) {
        if (element.dotDotDotToken) {
            return true;
        }
    }
    return false;
}

interface DestructureInfo {
    line: number;
    column: number;
    context: string;
    hasDisableComment: boolean;
}

/**
 * Find all destructuring patterns in a file using AST.
 */
// webpieces-disable max-lines-new-methods -- AST traversal with multiple destructuring pattern checks and exception detection
function findDestructuringInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean): DestructureInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: DestructureInfo[] = [];

    // webpieces-disable max-lines-new-methods -- AST visitor needs to handle object/array binding patterns in declarations, for-of, and parameters
    function visit(node: ts.Node): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // Check ObjectBindingPattern
            if (ts.isObjectBindingPattern(node)) {
                // Exception: rest operator separation
                if (hasRestElement(node)) {
                    ts.forEachChild(node, visit);
                    return;
                }

                const context = getDestructureContext(node);
                recordViolation(node, context, fileLines, sourceFile, violations, disableAllowed);
            }

            // Check ArrayBindingPattern
            if (ts.isArrayBindingPattern(node)) {
                // Exception: Promise.all destructure
                if (isPromiseAllDestructure(node)) {
                    ts.forEachChild(node, visit);
                    return;
                }

                // Exception: Object.entries in for-of
                if (isObjectEntriesForOf(node)) {
                    ts.forEachChild(node, visit);
                    return;
                }

                const context = getDestructureContext(node);
                recordViolation(node, context, fileLines, sourceFile, violations, disableAllowed);
            }
        } catch (err: unknown) {
            //const error = toError(err);
            // Skip nodes that cause errors during analysis
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

function recordViolation(
    node: ts.Node,
    context: string,
    fileLines: string[],
    sourceFile: ts.SourceFile,
    violations: DestructureInfo[],
    disableAllowed: boolean,
): void {
    const startPos = node.getStart(sourceFile);
    if (startPos >= 0) {
        const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
        const line = pos.line + 1;
        const column = pos.character + 1;
        const disabled = hasDisableComment(fileLines, line);

        if (!disableAllowed && disabled) {
            // When disableAllowed is false, ignore disable comments — still a violation
            violations.push({ line, column, context, hasDisableComment: false });
        } else {
            violations.push({ line, column, context, hasDisableComment: disabled });
        }
    }
}

/**
 * Get a description of where the destructuring pattern appears.
 */
function getDestructureContext(node: ts.Node): string {
    const parent = node.parent;
    if (ts.isParameter(parent)) {
        return 'function parameter destructuring';
    }
    if (ts.isVariableDeclaration(parent)) {
        const grandparent = parent.parent;
        if (grandparent && ts.isVariableDeclarationList(grandparent)) {
            const forOfParent = grandparent.parent;
            if (forOfParent && ts.isForOfStatement(forOfParent)) {
                return ts.isObjectBindingPattern(node)
                    ? 'object destructuring in for-of loop'
                    : 'array destructuring in for-of loop';
            }
        }
        return ts.isObjectBindingPattern(node)
            ? 'object destructuring in variable declaration'
            : 'array destructuring in variable declaration';
    }
    return ts.isObjectBindingPattern(node)
        ? 'object destructuring'
        : 'array destructuring';
}

/**
 * MODIFIED_CODE mode: Flag violations on changed lines in diff hunks.
 */
// webpieces-disable max-lines-new-methods -- File iteration with diff parsing and line filtering
function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean
): DestructureViolation[] {
    const violations: DestructureViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findDestructuringInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            // LINE-BASED: Only include if the violation is on a changed line
            if (!changedLines.has(v.line)) continue;

            violations.push({
                file,
                line: v.line,
                column: v.column,
                context: v.context,
            });
        }
    }

    return violations;
}

/**
 * NEW_AND_MODIFIED_FILES mode: Flag ALL violations in files that were modified.
 */
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): DestructureViolation[] {
    const violations: DestructureViolation[] = [];

    for (const file of changedFiles) {
        const allViolations = findDestructuringInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;

            violations.push({
                file,
                line: v.line,
                column: v.column,
                context: v.context,
            });
        }
    }

    return violations;
}

/**
 * Report violations to console.
 */
// webpieces-disable max-lines-new-methods -- Console output with examples and escape hatch information
function reportViolations(violations: DestructureViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c Destructuring patterns found! Use explicit property access instead.');
    console.error('');
    console.error('\ud83d\udcda Avoiding destructuring improves code traceability:');
    console.error('');
    console.error('   BAD:  const { name, age } = user;');
    console.error('   GOOD: const name = user.name;');
    console.error('         const age = user.age;');
    console.error('');
    console.error('   BAD:  function process({ x, y }: Point) { }');
    console.error('   GOOD: function process(point: Point) { point.x; point.y; }');
    console.error('');

    for (const v of violations) {
        console.error(`  \u274c ${v.file}:${v.line}:${v.column}`);
        console.error(`     ${v.context}`);
    }
    console.error('');

    console.error('   Allowed exceptions:');
    console.error('   - const [a, b] = await Promise.all([...])');
    console.error('   - for (const [key, value] of Object.entries(obj))');
    console.error('   - const { extracted, ...rest } = obj  (rest operator separation)');
    console.error('');

    if (disableAllowed) {
        console.error('   Escape hatch (use sparingly):');
        console.error('   // webpieces-disable no-destructure -- [your reason]');
    } else {
        console.error('   Escape hatch: DISABLED (disableAllowed: false)');
        console.error('   Disable comments are ignored. Fix the destructuring directly.');
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

/**
 * Resolve mode considering ignoreModifiedUntilEpoch override.
 * When active, downgrades to OFF. When expired, logs a warning.
 */
function resolveNoDestructureMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n\u23ed\ufe0f  Skipping no-destructure validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(
    options: NoDestructureConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveNoDestructureMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping no-destructure validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n\ud83d\udccf Validating No Destructuring\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping no-destructure validation (could not detect base branch)');
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

    let violations: DestructureViolation[] = [];

    if (mode === 'MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No destructuring patterns found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);

    return { success: false };
}

export class NoDestructureValidator extends CodeValidator<NoDestructureConfig> {
    constructor(config: NoDestructureConfig) {
        super(config, 'no-destructure');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
