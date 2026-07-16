/**
 * Validate Catch Error Pattern Executor
 *
 * Validates that catch blocks follow the standardized error handling pattern.
 * Uses TypeScript AST for detection and LINE-BASED git diff filtering.
 *
 * ============================================================================
 * REQUIRED PATTERN
 * ============================================================================
 *
 * Standard:    catch (err: unknown) { const error = toError(err); ... }
 * Ignored:     catch (err: unknown) { //const error = toError(err); ... }
 * Nested:      catch (err2: unknown) { const error2 = toError(err2); ... }
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * - catch (e) { ... }              — wrong parameter name
 * - catch (err) { ... }            — missing : unknown type annotation
 * - catch (err: unknown) { ... }   — missing toError() as first statement
 * - catch (err: unknown) { const x = toError(err); } — wrong variable name
 *
 * ============================================================================
 * MODES (LINE-BASED)
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - NEW_AND_MODIFIED_CODE:  Flag catch violations on changed lines (lines in diff hunks)
 * - NEW_AND_MODIFIED_FILES: Flag ALL catch violations in files that were modified
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable catch-error-pattern -- [your justification]
 *   } catch (err: unknown) {
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { hasDisable, RULE_NAMES, CatchErrorPatternConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { injectable, bindingScopeValues } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

interface CatchViolation {
    file: string;
    line: number;
    message: string;
    context: string;
}

interface CatchViolationInfo {
    line: number;
    message: string;
    context: string;
    hasDisableComment: boolean;
}

/**
 * Check if a line contains a disable comment for catch-error-pattern.
 * Recognizes both webpieces-disable and eslint-disable-next-line @webpieces/ formats.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (hasDisable(line, RULE_NAMES.CATCH_ERROR_PATTERN)) {
            return true;
        }
        if (line.includes('@webpieces/catch-error-pattern')) {
            return true;
        }
    }
    return false;
}

/**
 * Check if the catch block contains a disable comment for catch-error-pattern.
 */
function hasBlockLevelDisable(sourceText: string, blockStart: number, blockEnd: number): boolean {
    const blockText = sourceText.substring(blockStart, blockEnd);
    return hasDisable(blockText, RULE_NAMES.CATCH_ERROR_PATTERN) ||
        blockText.includes('@webpieces/catch-error-pattern');
}

/**
 * Check if the catch block body text contains the commented-out ignore pattern.
 */
function hasIgnoreComment(
    sourceText: string,
    blockStart: number,
    blockEnd: number,
    expectedVarName: string,
    actualParamName: string,
): boolean {
    const blockText = sourceText.substring(blockStart, blockEnd);
    const ignorePattern = new RegExp(
        `//\\s*const\\s+${expectedVarName}\\s*=\\s*toError\\(${actualParamName}\\)`,
    );
    return ignorePattern.test(blockText);
}

/**
 * Validate a single CatchClause node.
 */
// webpieces-disable max-lines-new-methods -- AST validation with multiple check paths for param name, type, and toError
function validateCatchClause(
    node: ts.CatchClause,
    sourceFile: ts.SourceFile,
    fileLines: string[],
    depth: number,
    disableAllowed: boolean,
): CatchViolationInfo[] {
    const violations: CatchViolationInfo[] = [];
    const suffix = depth === 1 ? '' : String(depth);
    const expectedParam = 'err' + suffix;
    const expectedVar = 'error' + suffix;

    const catchLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const catchContext = fileLines[catchLine - 1]?.trim() ?? '';
    const blockStart = node.block.getStart(sourceFile);
    const blockEnd = node.block.getEnd();
    const disabled = hasDisableComment(fileLines, catchLine) ||
        hasBlockLevelDisable(sourceFile.text, blockStart, blockEnd);

    const varDecl = node.variableDeclaration;
    if (!varDecl) {
        violations.push({
            line: catchLine, context: catchContext,
            message: `Catch clause must declare a parameter: catch (${expectedParam}: unknown)`,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        });
        return violations;
    }

    const actualParam = ts.isIdentifier(varDecl.name) ? varDecl.name.text : expectedParam;

    // Check parameter name
    if (ts.isIdentifier(varDecl.name) && varDecl.name.text !== expectedParam) {
        violations.push({
            line: catchLine, context: catchContext,
            message: `Catch parameter must be named "${expectedParam}" (or "err2", "err3" for nested), got "${varDecl.name.text}"`,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        });
    }

    // Check type annotation is : unknown
    if (!varDecl.type || varDecl.type.kind !== ts.SyntaxKind.UnknownKeyword) {
        violations.push({
            line: catchLine, context: catchContext,
            message: `Catch parameter must be typed as "unknown": catch (${actualParam}: unknown)`,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        });
    }

    // Check for commented-out ignore pattern
    if (hasIgnoreComment(sourceFile.text, blockStart, blockEnd, expectedVar, actualParam)) {
        return violations;
    }

    // Check first statement is const error = toError(err)
    if (node.block.statements.length === 0) {
        violations.push({
            line: catchLine, context: catchContext,
            message: `Catch block must call toError(${actualParam}) as first statement: const ${expectedVar} = toError(${actualParam});`,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        });
        return violations;
    }

    const firstStmt = node.block.statements[0];
    const toErrorViolation = validateToErrorStatement(firstStmt, sourceFile, fileLines, expectedParam, expectedVar, actualParam, disabled, disableAllowed);
    if (toErrorViolation) {
        violations.push(toErrorViolation);
    }

    return violations;
}

function resolveDisable(disabled: boolean, disableAllowed: boolean): boolean {
    if (!disableAllowed && disabled) {
        return false;
    }
    return disabled;
}

/**
 * Validate that the first statement is `const error = toError(err);`
 */
// webpieces-disable max-lines-new-methods -- Deep AST check for variable declaration with toError call expression
function validateToErrorStatement(
    stmt: ts.Statement,
    sourceFile: ts.SourceFile,
    fileLines: string[],
    expectedParam: string,
    expectedVar: string,
    actualParam: string,
    disabled: boolean,
    disableAllowed: boolean,
): CatchViolationInfo | null {
    const stmtLine = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
    const stmtContext = fileLines[stmtLine - 1]?.trim() ?? '';

    if (!ts.isVariableStatement(stmt)) {
        return {
            line: stmtLine,
            message: `First statement in catch must be: const ${expectedVar} = toError(${actualParam});`,
            context: stmtContext,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        };
    }

    const declarations = stmt.declarationList.declarations;
    if (declarations.length === 0) {
        return {
            line: stmtLine,
            message: `First statement in catch must be: const ${expectedVar} = toError(${actualParam});`,
            context: stmtContext,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        };
    }

    const decl = declarations[0];

    // Check variable name
    if (ts.isIdentifier(decl.name) && decl.name.text !== expectedVar) {
        return {
            line: stmtLine,
            message: `Error variable must be named "${expectedVar}", got "${decl.name.text}"`,
            context: stmtContext,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        };
    }

    // Check initializer is toError(actualParam)
    const init = decl.initializer;
    if (!init || !ts.isCallExpression(init)) {
        return {
            line: stmtLine,
            message: `First statement in catch must be: const ${expectedVar} = toError(${actualParam});`,
            context: stmtContext,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        };
    }

    if (!ts.isIdentifier(init.expression) || init.expression.text !== 'toError') {
        return {
            line: stmtLine,
            message: `First statement in catch must call toError(), not "${init.expression.getText(sourceFile)}"`,
            context: stmtContext,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        };
    }

    // Check argument
    const args = init.arguments;
    if (args.length !== 1 || !ts.isIdentifier(args[0]) || args[0].text !== actualParam) {
        return {
            line: stmtLine,
            message: `toError() must be called with "${actualParam}"`,
            context: stmtContext,
            hasDisableComment: resolveDisable(disabled, disableAllowed),
        };
    }

    return null;
}

/**
 * Find all catch pattern violations in a file using AST.
 */
function findCatchViolationsInFile(
    filePath: string,
    workspaceRoot: string,
    disableAllowed: boolean,
): CatchViolationInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: CatchViolationInfo[] = [];
    let catchDepth = 0;

    function visit(node: ts.Node): void {
        if (ts.isCatchClause(node)) {
            catchDepth++;
            const clauseViolations = validateCatchClause(node, sourceFile, fileLines, catchDepth, disableAllowed);
            violations.push(...clauseViolations);
            ts.forEachChild(node, visit);
            catchDepth--;
            return;
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

/**
 * NEW_AND_MODIFIED_CODE mode: Flag violations on changed lines.
 */
function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean,
): CatchViolation[] {
    const violations: CatchViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findCatchViolationsInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;

            violations.push({ file, line: v.line, message: v.message, context: v.context });
        }
    }

    return violations;
}

/**
 * NEW_AND_MODIFIED_FILES mode: Flag ALL violations in modified files.
 */
function findViolationsForModifiedFiles(
    workspaceRoot: string,
    changedFiles: string[],
    disableAllowed: boolean,
): CatchViolation[] {
    const violations: CatchViolation[] = [];

    for (const file of changedFiles) {
        const allViolations = findCatchViolationsInFile(file, workspaceRoot, disableAllowed);

        for (const v of allViolations) {
            if (disableAllowed && v.hasDisableComment) continue;
            violations.push({ file, line: v.line, message: v.message, context: v.context });
        }
    }

    return violations;
}

/**
 * Report violations to console.
 */
// webpieces-disable max-lines-new-methods -- Console output with pattern examples and escape hatch
function reportViolations(violations: CatchViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c Catch blocks must follow the standardized error handling pattern!');
    console.error('');
    console.error('\ud83d\udcda Required pattern:');
    console.error('');
    console.error('   catch (err: unknown) {');
    console.error('       const error = toError(err);');
    console.error('       // ... use error ...');
    console.error('   }');
    console.error('');
    console.error('   Or to explicitly ignore:');
    console.error('   catch (err: unknown) {');
    console.error('       //const error = toError(err);');
    console.error('   }');
    console.error('');
    console.error('   For nested catches: err2/error2, err3/error3, etc.');
    console.error('');

    for (const v of violations) {
        console.error(`  \u274c ${v.file}:${v.line}`);
        console.error(`     ${v.message}`);
        console.error(`     ${v.context}`);
    }
    console.error('');

    if (disableAllowed) {
        console.error('   Escape hatch (use sparingly):');
        console.error('   // webpieces-disable catch-error-pattern -- [your reason]');
    } else {
        console.error('   Escape hatch: DISABLED (disableAllowed: false)');
        console.error('   Disable comments are ignored. Fix the catch block directly.');
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
        console.log(`\n\u23ed\ufe0f  Skipping catch-error-pattern validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(
    options: CatchErrorPatternConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping catch-error-pattern validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n\ud83d\udccf Validating Catch Error Pattern\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping catch-error-pattern validation (could not detect base branch)');
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

    let violations: CatchViolation[] = [];

    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('\u2705 No catch error pattern violations found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);

    return { success: false };
}

@injectable(bindingScopeValues.Singleton)
export class CatchErrorPatternValidator extends CodeValidator<CatchErrorPatternConfig> {
    constructor(config: CatchErrorPatternConfig) {
        super(config, 'catch-error-pattern');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
