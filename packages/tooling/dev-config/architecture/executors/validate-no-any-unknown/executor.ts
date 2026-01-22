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
 * - MODIFIED_CODE:  Flag any/unknown on changed lines (lines in diff hunks)
 * - MODIFIED_FILES: Flag ALL any/unknown in files that were modified
 * - ALL:            Flag everywhere in all TypeScript files
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-any-unknown -- [your justification]
 *   const x: any = ...;
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type NoAnyUnknownMode = 'OFF' | 'MODIFIED_CODE' | 'MODIFIED_FILES' | 'ALL';

export interface ValidateNoAnyUnknownOptions {
    mode?: NoAnyUnknownMode;
}

export interface ExecutorResult {
    success: boolean;
}

interface AnyUnknownViolation {
    file: string;
    line: number;
    column: number;
    keyword: 'any' | 'unknown';
    context: string;
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
 * Get all TypeScript files in the workspace using git ls-files (excluding tests).
 */
function getAllTypeScriptFiles(workspaceRoot: string): string[] {
    try {
        const output = execSync(`git ls-files '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        return output
            .trim()
            .split('\n')
            .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));
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
 * Parse diff to extract changed line numbers (additions only - lines starting with +).
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
 * Check if a line contains a webpieces-disable comment for no-any-unknown.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('no-any-unknown')) {
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
    } catch {
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
        try {
            // Detect `any` keyword
            if (node.kind === ts.SyntaxKind.AnyKeyword) {
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
        } catch {
            // Skip nodes that cause errors during analysis
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

/**
 * MODIFIED_CODE mode: Flag violations on changed lines in diff hunks.
 * This is LINE-BASED detection.
 */
// webpieces-disable max-lines-new-methods -- File iteration with diff parsing and line filtering
function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head?: string
): AnyUnknownViolation[] {
    const violations: AnyUnknownViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);

        if (changedLines.size === 0) continue;

        const allViolations = findAnyUnknownInFile(file, workspaceRoot);

        for (const v of allViolations) {
            if (v.hasDisableComment) continue;
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
 * MODIFIED_FILES mode: Flag ALL violations in files that were modified.
 */
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[]): AnyUnknownViolation[] {
    const violations: AnyUnknownViolation[] = [];

    for (const file of changedFiles) {
        const allViolations = findAnyUnknownInFile(file, workspaceRoot);

        for (const v of allViolations) {
            if (v.hasDisableComment) continue;

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
 * ALL mode: Flag violations in all TypeScript files.
 */
function findViolationsForAll(workspaceRoot: string): AnyUnknownViolation[] {
    const allFiles = getAllTypeScriptFiles(workspaceRoot);
    return findViolationsForModifiedFiles(workspaceRoot, allFiles);
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
function reportViolations(violations: AnyUnknownViolation[], mode: NoAnyUnknownMode): void {
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

export default async function runExecutor(
    options: ValidateNoAnyUnknownOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: NoAnyUnknownMode = options.mode ?? 'OFF';

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping no-any-unknown validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating No Any/Unknown\n');
    console.log(`   Mode: ${mode}`);

    let violations: AnyUnknownViolation[] = [];

    if (mode === 'ALL') {
        console.log('   Scope: All tracked TypeScript files');
        console.log('');
        violations = findViolationsForAll(workspaceRoot);
    } else {
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

        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        if (mode === 'MODIFIED_CODE') {
            violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head);
        } else if (mode === 'MODIFIED_FILES') {
            violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles);
        }
    }

    if (violations.length === 0) {
        console.log('✅ No any/unknown keywords found');
        return { success: true };
    }

    reportViolations(violations, mode);

    return { success: false };
}
