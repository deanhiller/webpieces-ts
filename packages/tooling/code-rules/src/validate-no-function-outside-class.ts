/**
 * Validate No Function Outside Class
 *
 * Flags a function CREATED OUTSIDE A CLASS at module scope:
 *   - a top-level `function foo()` / `export function foo()` declaration, and
 *   - a top-level `const foo = () => {}` / `const foo = function(){}`.
 *
 * WHY: webpieces DI + @DocumentDesign only work when behavior lives in injectable classes that can be
 * wired into each other. A module-scope function is a dead-end the DI graph can't reach — move the
 * logic onto a `@provideSingleton()` class and inject it instead.
 *
 * Uses the TypeScript AST so class-membership is checked precisely (not a regex heuristic): a node is a
 * violation only when its parent is the SourceFile (module scope). That automatically EXEMPTS inline
 * callbacks (`arr.map(x => x)`), promise handlers, nested functions inside methods, and functions
 * nested in other functions — their parent is a Block/CallExpression, never the SourceFile.
 *
 * ALLOWED (skip — NOT violations)
 * - Any function/arrow nested inside a class method, another function, or a callback.
 * - Non-function top-level consts: `const SCHEMA = z.object({})`, `const MAX = 5`, object/array literals.
 * - Ambient declarations (`declare function ...`) and whole `*.d.ts` files.
 * - Test files (*.test.ts, *.spec.ts, __tests__/**).
 * - Lines with `// webpieces-disable no-function-outside-class -- <reason>` (when disableAllowed).
 *
 * MODES (AST + LINE-SCOPED)
 * - OFF:                    Skip.
 * - NEW_AND_MODIFIED_CODE:  Flag only on changed lines (diff hunks).
 * - NEW_AND_MODIFIED_FILES: Flag every occurrence in any modified file.
 *
 * NOTE: intentionally NO allowedPaths — the only escapes are the inline `// webpieces-disable` comment
 * and the universal epoch/branch off-switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { hasDisable, RULE_NAMES, NoFunctionOutsideClassConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

const SHARED_MESSAGE = `Functions must live inside a class — a function created at module scope can't be injected, so
webpieces DI + @DocumentDesign can't wire it into anything.
  BAD:   export function computeTotal(cart: Cart): number { ... }
  GOOD:  @provideSingleton()
         export class CartService { computeTotal(cart: Cart): number { ... } }
Then inject CartService where you need it. Inline callbacks (arr.map(x => x)), promise handlers, and
functions nested inside a method are fine — only MODULE-SCOPE function declarations and top-level
const-assigned functions are flagged.`;

interface FnViolation {
    file: string;
    line: number;
    column: number;
    context: string;
}

interface FnViolationInfo {
    line: number;
    column: number;
    context: string;
    hasDisableComment: boolean;
}

function isTestFile(filePath: string): boolean {
    return filePath.includes('.spec.ts') || filePath.includes('.test.ts') || filePath.includes('__tests__/');
}

function isDeclarationFile(filePath: string): boolean {
    return filePath.endsWith('.d.ts');
}

// True for a node carrying a `declare` modifier (ambient signature — not a real definition).
function hasDeclareModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return mods?.some((m: ts.Modifier): boolean => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

// The violation line (or the line just above it) carries the disable comment.
function hasDisableOnLine(fileLines: string[], lineNumber: number): boolean {
    const current = fileLines[lineNumber - 1] ?? '';
    const previous = lineNumber >= 2 ? (fileLines[lineNumber - 2] ?? '') : '';
    return hasDisable(current, RULE_NAMES.NO_FUNCTION_OUTSIDE_CLASS)
        || hasDisable(previous, RULE_NAMES.NO_FUNCTION_OUTSIDE_CLASS);
}

function recordViolation(
    node: ts.Node,
    context: string,
    fileLines: string[],
    sourceFile: ts.SourceFile,
    violations: FnViolationInfo[],
    disableAllowed: boolean,
): void {
    const startPos = node.getStart(sourceFile);
    if (startPos < 0) return;
    const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
    const line = pos.line + 1;
    const column = pos.character + 1;
    const disabled = hasDisableOnLine(fileLines, line);
    // When disableAllowed is false, a disable comment does NOT clear the violation.
    const effectiveDisabled = disableAllowed ? disabled : false;
    violations.push({ line, column, context, hasDisableComment: effectiveDisabled });
}

// Report a module-scope const whose initializer is an arrow / function-expression (a function
// assigned to a top-level const). Non-function consts are left alone.
function checkTopLevelConst(
    node: ts.VariableStatement,
    fileLines: string[],
    sourceFile: ts.SourceFile,
    violations: FnViolationInfo[],
    disableAllowed: boolean,
): void {
    for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (!init) continue;
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        const name = ts.isIdentifier(decl.name) ? decl.name.text : '<fn>';
        recordViolation(decl, `const ${name} = <function> at module scope (outside any class)`, fileLines, sourceFile, violations, disableAllowed);
    }
}

// AST scan: a node is a violation only when its parent is the SourceFile (module scope).
export function findFunctionsOutsideClassInSource(content: string, filePath: string, disableAllowed: boolean): FnViolationInfo[] {
    if (isDeclarationFile(filePath)) return [];
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const violations: FnViolationInfo[] = [];

    function visit(node: ts.Node): void {
        if (ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent) && !hasDeclareModifier(node)) {
            const name = node.name?.text ?? '<anonymous>';
            recordViolation(node, `function ${name}() declared at module scope (outside any class)`, fileLines, sourceFile, violations, disableAllowed);
        }
        if (ts.isVariableStatement(node) && ts.isSourceFile(node.parent) && !hasDeclareModifier(node)) {
            checkTopLevelConst(node, fileLines, sourceFile, violations, disableAllowed);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

function findFunctionsOutsideClassInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean): FnViolationInfo[] {
    if (isTestFile(filePath)) return [];
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];
    const content = fs.readFileSync(fullPath, 'utf-8');
    return findFunctionsOutsideClassInSource(content, filePath, disableAllowed);
}

function findViolationsForModifiedCode(workspaceRoot: string, changedFiles: string[], base: string, head: string | undefined, disableAllowed: boolean): FnViolation[] {
    const violations: FnViolation[] = [];
    for (const file of changedFiles) {
        const changedLines = getChangedLineNumbers(getFileDiff(workspaceRoot, file, base, head));
        if (changedLines.size === 0) continue;
        for (const v of findFunctionsOutsideClassInFile(file, workspaceRoot, disableAllowed)) {
            if (disableAllowed && v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;
            violations.push({ file, line: v.line, column: v.column, context: v.context });
        }
    }
    return violations;
}

function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): FnViolation[] {
    const violations: FnViolation[] = [];
    for (const file of changedFiles) {
        for (const v of findFunctionsOutsideClassInFile(file, workspaceRoot, disableAllowed)) {
            if (disableAllowed && v.hasDisableComment) continue;
            violations.push({ file, line: v.line, column: v.column, context: v.context });
        }
    }
    return violations;
}

function reportViolations(violations: FnViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
    console.error('');
    console.error('❌ Function(s) created outside a class!');
    console.error('');
    console.error(SHARED_MESSAGE);
    console.error('');
    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}:${v.column}`);
        console.error(`     ${v.context}`);
    }
    console.error('');
    console.error(disableAllowed
        ? '   Escape hatch (use sparingly): // webpieces-disable no-function-outside-class -- <reason>'
        : '   Escape hatch: DISABLED (disableAllowed: false)');
    console.error(`\n   Current mode: ${mode}\n`);
}

function resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
    if (normalMode === 'OFF') return normalMode;
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping no-function-outside-class validation (${skip.reason})\n`);
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(options: NoFunctionOutsideClassConfig, workspaceRoot: string): Promise<ExecutorResult> {
    const mode: ModifiedCodeMode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping no-function-outside-class validation (mode: OFF)\n');
        return { success: true };
    }

    console.log('\n📏 Validating No Function Outside Class\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];
    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log('\n⏭️  Skipping no-function-outside-class validation (could not detect base branch)\n');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}\n`);

    const changedFiles = getChangedFiles(workspaceRoot, base, head);
    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    let violations: FnViolation[] = [];
    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('✅ No function-outside-class violations found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);
    return { success: false };
}

export class NoFunctionOutsideClassValidator extends CodeValidator<NoFunctionOutsideClassConfig> {
    constructor(config: NoFunctionOutsideClassConfig) {
        super(config, 'no-function-outside-class');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
