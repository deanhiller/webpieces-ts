/**
 * Validate Return Types Executor
 *
 * Validates that methods have explicit return type annotations for better code readability.
 * Instead of relying on TypeScript's type inference, explicit return types make code clearer:
 *
 * BAD:  method() { return new MyClass(); }
 * GOOD: method(): MyClass { return new MyClass(); }
 * GOOD: async method(): Promise<MyType> { ... }
 *
 * Modes:
 * - OFF: Skip validation entirely
 * - NEW_METHODS: Only validate new methods (detected via git diff)
 * - NEW_AND_MODIFIED_METHODS: Validate new methods + methods with changes in their line range
 * - NEW_AND_MODIFIED_FILES: Validate all methods in modified files
 *
 * Escape hatch: Add webpieces-disable require-return-type comment with justification
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    hasDisable,
    RULE_NAMES,
    RequireReturnTypeConfig,
    ReturnTypeMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
    findNewMethodSignaturesInDiff,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { provideSingleton } from '@webpieces/rules-config';
import { injectable } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

interface MethodViolation {
    file: string;
    methodName: string;
    line: number;
}

/**
 * Check if a line contains a webpieces-disable comment for return type.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (hasDisable(line, RULE_NAMES.REQUIRE_RETURN_TYPE)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a method has an explicit return type annotation.
 */
function hasExplicitReturnType(node: ts.MethodDeclaration | ts.FunctionDeclaration | ts.ArrowFunction): boolean {
    return node.type !== undefined;
}

interface MethodInfo {
    name: string;
    line: number;
    endLine: number;
    hasReturnType: boolean;
    hasDisableComment: boolean;
}

/**
 * Parse a TypeScript file and find methods with their return type status.
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
        let hasReturnType = false;

        if (ts.isMethodDeclaration(node) && node.name) {
            methodName = node.name.getText(sourceFile);
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            startLine = start.line + 1;
            endLine = end.line + 1;
            hasReturnType = hasExplicitReturnType(node);
        } else if (ts.isFunctionDeclaration(node) && node.name) {
            methodName = node.name.getText(sourceFile);
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
            startLine = start.line + 1;
            endLine = end.line + 1;
            hasReturnType = hasExplicitReturnType(node);
        } else if (ts.isArrowFunction(node)) {
            if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
                methodName = node.parent.name.getText(sourceFile);
                const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
                startLine = start.line + 1;
                endLine = end.line + 1;
                hasReturnType = hasExplicitReturnType(node);
            }
        }

        if (methodName && startLine !== undefined && endLine !== undefined) {
            methods.push({
                name: methodName,
                line: startLine,
                endLine,
                hasReturnType,
                hasDisableComment: hasDisableComment(fileLines, startLine),
            });
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return methods;
}

/**
 * Check if a method has any changed lines within its range.
 */
function methodHasChanges(method: MethodInfo, changedLines: Set<number>): boolean {
    for (let line = method.line; line <= method.endLine; line++) {
        if (changedLines.has(line)) {
            return true;
        }
    }
    return false;
}

/**
 * Find NEW methods without explicit return types (NEW_METHODS mode).
 */
// webpieces-disable max-lines-new-methods -- File iteration with diff parsing and method matching
function findViolationsForNewMethods(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);

        if (newMethodNames.size === 0) continue;

        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            if (!newMethodNames.has(method.name)) continue;
            if (method.hasReturnType) continue;
            if (disableAllowed && method.hasDisableComment) continue;

            violations.push({
                file,
                methodName: method.name,
                line: method.line,
            });
        }
    }

    return violations;
}

/**
 * Find NEW methods AND methods with changes (NEW_AND_MODIFIED_METHODS mode).
 */
// webpieces-disable max-lines-new-methods -- Combines new method detection with change detection
function findViolationsForModifiedAndNewMethods(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    disableAllowed: boolean
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);
        const changedLines = getChangedLineNumbers(diff);

        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            if (method.hasReturnType) continue;
            if (disableAllowed && method.hasDisableComment) continue;

            const isNewMethod = newMethodNames.has(method.name);
            const isModifiedMethod = methodHasChanges(method, changedLines);

            if (!isNewMethod && !isModifiedMethod) continue;

            violations.push({
                file,
                methodName: method.name,
                line: method.line,
            });
        }
    }

    return violations;
}

/**
 * Find all methods without explicit return types in modified files (NEW_AND_MODIFIED_FILES mode).
 */
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            if (method.hasReturnType) continue;
            if (disableAllowed && method.hasDisableComment) continue;

            violations.push({
                file,
                methodName: method.name,
                line: method.line,
            });
        }
    }

    return violations;
}

/**
 * Report violations to console.
 */
function reportViolations(violations: MethodViolation[], mode: ReturnTypeMode): void {
    console.error('');
    console.error('❌ Methods missing explicit return types!');
    console.error('');
    console.error('📚 Explicit return types improve code readability:');
    console.error('');
    console.error('   BAD:  method() { return new MyClass(); }');
    console.error('   GOOD: method(): MyClass { return new MyClass(); }');
    console.error('   GOOD: async method(): Promise<MyType> { ... }');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     Method: ${v.methodName} - missing return type annotation`);
    }
    console.error('');

    console.error('   To fix: Add explicit return type after the parameter list');
    console.error('');
    console.error('   Escape hatch (use sparingly):');
    console.error('   // webpieces-disable require-return-type -- [your reason]');
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

/**
 * Resolve mode considering ignoreModifiedUntilEpoch override.
 * When active, downgrades to OFF. When expired, logs a warning.
 */
function resolveMode(normalMode: ReturnTypeMode, epoch: number | undefined, branchPattern: string | undefined): ReturnTypeMode {
    if (normalMode === 'OFF') {
        return normalMode;
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping require-return-type validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(
    options: RequireReturnTypeConfig,
    workspaceRoot: string
): Promise<ExecutorResult> {
    const mode: ReturnTypeMode = resolveMode(options.mode ?? 'NEW_METHODS', options.ignoreModifiedUntilEpoch, options.ignoreRuleWhileOnBranch);
    const disableAllowed = options.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping return type validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating Return Types\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping return type validation (could not detect base branch)');
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

    let violations: MethodViolation[] = [];

    if (mode === 'NEW_METHODS') {
        violations = findViolationsForNewMethods(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_METHODS') {
        violations = findViolationsForModifiedAndNewMethods(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('✅ All methods have explicit return types');
        return { success: true };
    }

    reportViolations(violations, mode);

    return { success: false };
}

@provideSingleton()
@injectable()
export class RequireReturnTypeValidator extends CodeValidator<RequireReturnTypeConfig> {
    constructor(config: RequireReturnTypeConfig) {
        super(config, 'require-return-type');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
