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
 * - MODIFIED_AND_NEW_METHODS: Validate new methods + methods with changes in their line range
 * - MODIFIED_FILES: Validate all methods in modified files
 *
 * Escape hatch: Add webpieces-disable require-return-type comment with justification
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type ReturnTypeMode = 'OFF' | 'NEW_METHODS' | 'MODIFIED_AND_NEW_METHODS' | 'MODIFIED_FILES';

export interface ValidateReturnTypesOptions {
    mode?: ReturnTypeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface ExecutorResult {
    success: boolean;
}

interface MethodViolation {
    file: string;
    methodName: string;
    line: number;
}

/**
 * Get changed TypeScript files between base and head (or working tree if head not specified).
 */
// webpieces-disable max-lines-new-methods -- Git command handling with untracked files requires multiple code paths
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));

        if (!head) {
            try {
                const untrackedOutput = execSync(`git ls-files --others --exclude-standard '*.ts' '*.tsx'`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                });
                const untrackedFiles = untrackedOutput
                    .trim()
                    .split('\n')
                    .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            } catch {
                return changedFiles;
            }
        }

        return changedFiles;
    } catch {
        return [];
    }
}

/**
 * Get the diff content for a specific file.
 */
function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
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
    } catch {
        return '';
    }
}

/**
 * Parse diff to find newly added method signatures.
 */
function findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
    const newMethods = new Set<string>();
    const lines = diffContent.split('\n');

    const patterns = [
        /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
        /^\+\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
        /^\+\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
        /^\+\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
    ];

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    const methodName = match[1];
                    if (methodName && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodName)) {
                        newMethods.add(methodName);
                    }
                    break;
                }
            }
        }
    }

    return newMethods;
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
        if (line.includes('webpieces-disable') && line.includes('require-return-type')) {
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
 * Parse diff to extract changed line numbers (both additions and modifications).
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
 * Find NEW methods AND methods with changes (MODIFIED_AND_NEW_METHODS mode).
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
 * Find all methods without explicit return types in modified files (MODIFIED_FILES mode).
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
 * Auto-detect the base branch by finding the merge-base with origin/main.
 */
function detectBase(workspaceRoot: string): string | null {
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    } catch {
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (mergeBase) {
                return mergeBase;
            }
        } catch {
            // Ignore
        }
    }
    return null;
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
function resolveMode(normalMode: ReturnTypeMode, epoch: number | undefined): ReturnTypeMode {
    if (epoch === undefined || normalMode === 'OFF') {
        return normalMode;
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
        console.log(`\n⏭️  Skipping require-return-type validation (ignoreModifiedUntilEpoch active, expires: ${expiresDate})`);
        console.log('');
        return 'OFF';
    }
    const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
    console.log(`\n⚠️  requireReturnType.ignoreModifiedUntilEpoch (${epoch}) has expired (${expiresDate}). Remove it from nx.json. Using normal mode: ${normalMode}\n`);
    return normalMode;
}

export default async function runExecutor(
    options: ValidateReturnTypesOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: ReturnTypeMode = resolveMode(options.mode ?? 'NEW_METHODS', options.ignoreModifiedUntilEpoch);
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

    const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    let violations: MethodViolation[] = [];

    if (mode === 'NEW_METHODS') {
        violations = findViolationsForNewMethods(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'MODIFIED_AND_NEW_METHODS') {
        violations = findViolationsForModifiedAndNewMethods(workspaceRoot, changedFiles, base, head, disableAllowed);
    } else if (mode === 'MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);
    }

    if (violations.length === 0) {
        console.log('✅ All methods have explicit return types');
        return { success: true };
    }

    reportViolations(violations, mode);

    return { success: false };
}
