/**
 * Validate No Any Unknown Executor
 *
 * Validates that `any` and `unknown` TypeScript keywords are not used.
 * Uses LINE-BASED detection (not method-based) for git diff filtering.
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * - const x: any = ...
 * - function foo(arg: any): any { }
 * - const data = response as any;
 * - type T = any;
 * - const x: unknown = ...
 * - function foo(arg: unknown): unknown { }
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - NEW_AND_MODIFIED_CODE:  Flag any/unknown on changed lines (lines in diff hunks)
 * - NEW_AND_MODIFIED_FILES: Flag ALL any/unknown in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-any-unknown -- [your justification]
 *   const x: any = ...;
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { hasDisable, RULE_NAMES, NoAnyUnknownConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { injectable, bindingScopeValues } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

interface AnyUnknownViolation {
    file: string;
    line: number;
    column: number;
    keyword: 'any' | 'unknown';
    context: string;
}

/**
 * Check if a line contains a webpieces-disable comment for no-any-unknown.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (hasDisable(line, RULE_NAMES.NO_ANY_UNKNOWN)) {
            return true;
        }
    }
    return false;
}

/**
 * Get a description of the context where the any/unknown keyword appears.
 */
// webpieces-disable max-lines-new-methods -- Context detection requires checking many AST node types
function getViolationContext(node: ts.Node, sourceFile: ts.SourceFile): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        let current: ts.Node = node;
        while (current.parent) {
            const parent = current.parent;
            if (ts.isParameter(parent)) {
                return 'parameter type';
            }
            if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isArrowFunction(parent)) {
                if (parent.type === current) {
                    return 'return type';
                }
            }
            if (ts.isVariableDeclaration(parent)) {
                return 'variable type';
            }
            if (ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) {
                return 'property type';
            }
            if (ts.isAsExpression(parent)) {
                return 'type assertion';
            }
            if (ts.isTypeAliasDeclaration(parent)) {
                return 'type alias';
            }
            if (ts.isTypeReferenceNode(parent)) {
                return 'generic argument';
            }
            if (ts.isArrayTypeNode(parent)) {
                return 'array element type';
            }
            if (ts.isUnionTypeNode(parent) || ts.isIntersectionTypeNode(parent)) {
                return 'union/intersection type';
            }
            current = parent;
        }
        return 'type position';
    } catch (err: unknown) {
        //const error = toError(err);
        return 'type position';
    }
}

interface AnyUnknownInfo {
    line: number;
    column: number;
    keyword: 'any' | 'unknown';
    context: string;
    hasDisableComment: boolean;
}

/**
 * Check if a node is in a catch clause variable declaration.
 * This allows `catch (err: unknown)` and `catch (err: unknown)` patterns.
 */
function isInCatchClause(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (ts.isCatchClause(current)) {
            // We're somewhere in a catch clause - check if we're in the variable declaration
            const catchClause = current as ts.CatchClause;
            if (catchClause.variableDeclaration) {
                // Walk back up from the original node to see if we're part of the variable declaration
                let checkNode: ts.Node | undefined = node.parent;
                while (checkNode && checkNode !== current) {
                    if (checkNode === catchClause.variableDeclaration) {
                        return true;
                    }
                    checkNode = checkNode.parent;
                }
            }
        }
        current = current.parent;
    }
    return false;
}

/**
 * Find all `any` and `unknown` keywords in a file using AST.
 */
// webpieces-disable max-lines-new-methods -- AST traversal with nested visitor function for keyword detection
function findAnyUnknownInFile(filePath: string, workspaceRoot: string): AnyUnknownInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: AnyUnknownInfo[] = [];

    // webpieces-disable max-lines-new-methods -- AST visitor needs to handle both any and unknown keywords with full context detection
    function visit(node: ts.Node): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // Detect `any` keyword
            if (node.kind === ts.SyntaxKind.AnyKeyword) {
                // Skip catch clause variable types: catch (err: unknown) is allowed
                if (isInCatchClause(node)) {
                    ts.forEachChild(node, visit);
                    return;
                }

                const startPos = node.getStart(sourceFile);
                if (startPos >= 0) {
                    const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                    const line = pos.line + 1;
                    const column = pos.character + 1;
                    const context = getViolationContext(node, sourceFile);
                    const disabled = hasDisableComment(fileLines, line);

                    violations.push({
                        line,
                        column,
                        keyword: 'any',
                        context,
                        hasDisableComment: disabled,
                    });
                }
            }

            // Detect `unknown` keyword
            if (node.kind === ts.SyntaxKind.UnknownKeyword) {
                // Skip catch clause variable types: catch (err: unknown) is allowed
                if (isInCatchClause(node)) {
                    ts.forEachChild(node, visit);
                    return;
                }

                const startPos = node.getStart(sourceFile);
                if (startPos >= 0) {
                    const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                    const line = pos.line + 1;
                    const column = pos.character + 1;
                    const context = getViolationContext(node, sourceFile);
                    const disabled = hasDisableComment(fileLines, line);

                    violations.push({
                        line,
                        column,
                        keyword: 'unknown',
                        context,
                        hasDisableComment: disabled,
                    });
                }
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

/**
 * NEW_AND_MODIFIED_CODE mode: Flag violations on changed lines in diff hunks.
 * This is LINE-BASED detection.
 */
// webpieces-disable max-lines-new-methods -- File iteration with diff parsing and line filtering
function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean
): AnyUnknownViolation[] {
    const violations: AnyUnknownViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findAnyUnknownInFile(file, workspaceRoot);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            // LINE-BASED: Only include if the violation is on a changed line
            if (!changedLines.has(v.line)) continue;

            violations.push({
                file,
                line: v.line,
                column: v.column,
                keyword: v.keyword,
                context: v.context,
            });
        }
    }

    return violations;
}

/**
 * NEW_AND_MODIFIED_FILES mode: Flag ALL violations in files that were modified.
 */
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): AnyUnknownViolation[] {
    const violations: AnyUnknownViolation[] = [];

    for (const file of changedFiles) {
        const allViolations = findAnyUnknownInFile(file, workspaceRoot);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;

            violations.push({
                file,
                line: v.line,
                column: v.column,
                keyword: v.keyword,
                context: v.context,
            });
        }
    }

    return violations;
}

/**
 * Report violations to console.
 */
function reportViolations(violations: AnyUnknownViolation[], mode: ModifiedCodeMode): void {
    console.error('');
    console.error('❌ `any` and `unknown` keywords found! Use specific types instead.');
    console.error('');
    console.error('📚 Avoiding any/unknown improves type safety:');
    console.error('');
    console.error('   BAD:  const data: any = fetchData();');
    console.error('   GOOD: const data: UserData = fetchData();');
    console.error('');
    console.error('   BAD:  function process(input: unknown): unknown { }');
    console.error('   GOOD: function process(input: ValidInput): ValidOutput { }');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}:${v.column}`);
        console.error(`     \`${v.keyword}\` keyword in ${v.context}`);
    }
    console.error('');

    console.error('   To fix: Replace with specific types or interfaces');
    console.error('');
    console.error('   Escape hatch (use sparingly):');
    console.error('   // webpieces-disable no-any-unknown -- [your reason]');
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

/**
 * Resolve mode considering ignoreModifiedUntilEpoch override.
 * When active, downgrades to OFF. When expired, logs a warning.
 */
function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping no-any-unknown validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(
    options: NoAnyUnknownConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping no-any-unknown validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating No Any/Unknown\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping no-any-unknown validation (could not detect base branch)');
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const changedFiles = getChangedFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    let violations: AnyUnknownViolation[] = [];

    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('✅ No any/unknown keywords found');
        return { success: true };
    }

    reportViolations(violations, mode);

    return { success: false };
}

@injectable(bindingScopeValues.Singleton)
export class NoAnyUnknownValidator extends CodeValidator<NoAnyUnknownConfig> {
    constructor(config: NoAnyUnknownConfig) {
        super(config, 'no-any-unknown');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
