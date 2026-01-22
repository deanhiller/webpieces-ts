/**
 * Validate No Inline Types Executor
 *
 * Validates that inline type literals AND tuple types are not used in type positions.
 * Prefer named types/interfaces/classes for clarity and reusability.
 *
 * ============================================================================
 * VIOLATIONS (BAD) - These patterns are flagged:
 * ============================================================================
 *
 * 1. INLINE TYPE LITERALS { }
 *    -------------------------
 *    - Inline parameter type:     function foo(arg: { x: number }) { }
 *    - Inline return type:        function foo(): { x: number } { }
 *    - Inline variable type:      const config: { timeout: number } = { timeout: 5 };
 *    - Inline property type:      class C { data: { id: number }; }
 *    - Inline in union:           type T = { x: number } | null;
 *    - Inline in intersection:    type T = { x: number } & { y: number };
 *    - Inline in generic:         Promise<{ data: string }>
 *    - Inline in array:           function foo(): { id: string }[] { }
 *    - Nested inline in alias:    type T = { data: { nested: number } };  // inner { } flagged
 *    - Inline in tuple:           type T = [{ x: number }, string];
 *
 * 2. TUPLE TYPES [ ]
 *    ----------------
 *    - Tuple return type:         function foo(): [Items[], number] { }
 *    - Tuple parameter type:      function foo(arg: [string, number]) { }
 *    - Tuple variable type:       const result: [Data[], number] = getData();
 *    - Tuple in generic:          Promise<[Items[], number]>
 *    - Tuple in union:            type T = [A, B] | null;
 *    - Nested tuple:              type T = { data: [A, B] };
 *
 * ============================================================================
 * ALLOWED (GOOD) - These patterns pass validation:
 * ============================================================================
 *
 * 1. TYPE ALIAS DEFINITIONS (direct body only)
 *    -----------------------------------------
 *    - Type alias with literal:   type MyConfig = { timeout: number };
 *    - Type alias with tuple:     type MyResult = [Items[], number];
 *    - Interface definition:      interface MyData { id: number }
 *    - Class definition:          class UserData { id: number; name: string; }
 *
 * 2. USING NAMED TYPES
 *    ------------------
 *    - Named param type:          function foo(arg: MyConfig) { }
 *    - Named return type:         function foo(): MyConfig { }
 *    - Named with null:           function foo(): MyConfig | null { }
 *    - Named with undefined:      function foo(): MyConfig | undefined { }
 *    - Union of named types:      type Either = TypeA | TypeB;
 *    - Named in generic:          Promise<MyResult>
 *    - Named tuple alias:         function foo(): MyTupleResult { }
 *
 * 3. PRIMITIVES AND BUILT-INS
 *    -------------------------
 *    - Primitive types:           function foo(): string { }
 *    - Primitive arrays:          function foo(): string[] { }
 *    - Built-in generics:         function foo(): Promise<string> { }
 *    - Void return:               function foo(): void { }
 *
 * ============================================================================
 * MODES
 * ============================================================================
 * - OFF:                      Skip validation entirely
 * - NEW_METHODS:              Only validate in new methods (detected via git diff)
 * - MODIFIED_AND_NEW_METHODS: Validate in new methods + methods with changes
 * - MODIFIED_FILES:           Validate all violations in modified files
 * - ALL:                      Validate all violations in all TypeScript files
 *
 * ============================================================================
 * ESCAPE HATCH
 * ============================================================================
 * Add comment above the violation:
 *   // webpieces-disable no-inline-types -- [your justification]
 *   function foo(arg: { x: number }) { }
 *
 * Use sparingly! Common valid reasons:
 * - Prisma payload types that require inline generics
 * - Third-party library APIs that expect inline types
 * - Legacy code being incrementally migrated
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type NoInlineTypesMode = 'OFF' | 'NEW_METHODS' | 'MODIFIED_AND_NEW_METHODS' | 'MODIFIED_FILES' | 'ALL';

export interface ValidateNoInlineTypesOptions {
    mode?: NoInlineTypesMode;
}

export interface ExecutorResult {
    success: boolean;
}

interface InlineTypeViolation {
    file: string;
    line: number;
    column: number;
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
 * Check if a line contains a webpieces-disable comment for no-inline-types.
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('no-inline-types')) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a TypeLiteral or TupleType node is in an allowed context.
 * Only allowed if the DIRECT parent is a TypeAliasDeclaration.
 *
 * ALLOWED:
 *   type MyConfig = { x: number };     // TypeLiteral direct child of TypeAliasDeclaration
 *   type MyTuple = [A, B];             // TupleType direct child of TypeAliasDeclaration
 *
 * NOT ALLOWED (flagged):
 *   type T = { x: number } | null;     // Parent is UnionType, not TypeAliasDeclaration
 *   type T = { data: { nested: number } };  // Inner TypeLiteral's parent is PropertySignature
 *   function foo(): [A, B] { }         // TupleType's parent is FunctionDeclaration
 *   type T = Prisma.GetPayload<{ include: {...} }>;  // TypeLiteral in generic argument
 *
 * NOTE: Prisma types require inline type literals in generic arguments. Use the escape hatch:
 *   // webpieces-disable no-inline-types -- Prisma API requires inline type argument
 *   type T = Prisma.GetPayload<{ include: {...} }>;
 */
function isInAllowedContext(node: ts.TypeLiteralNode | ts.TupleTypeNode): boolean {
    const parent = node.parent;
    if (!parent) return false;

    // Only allowed if it's the DIRECT body of a type alias
    if (ts.isTypeAliasDeclaration(parent)) {
        return true;
    }
    return false;
}

/**
 * Get a description of the context where the inline type or tuple appears.
 *
 * Returns human-readable context like:
 *   - "inline parameter type"
 *   - "tuple return type"
 *   - "inline type in generic argument"
 */
// webpieces-disable max-lines-new-methods -- Context detection requires checking many AST node types
function getViolationContext(node: ts.TypeLiteralNode | ts.TupleTypeNode, sourceFile: ts.SourceFile): string {
    try {
        const isTuple = ts.isTupleTypeNode(node);
        const prefix = isTuple ? 'tuple' : 'inline';

        let current: ts.Node = node;
        while (current.parent) {
            const parent = current.parent;
            if (ts.isParameter(parent)) {
                return `${prefix} parameter type`;
            }
            if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isArrowFunction(parent)) {
                if (parent.type === current) {
                    return `${prefix} return type`;
                }
            }
            if (ts.isVariableDeclaration(parent)) {
                return `${prefix} variable type`;
            }
            if (ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) {
                if (parent.type === current) {
                    return `${prefix} property type`;
                }
                // Check if it's nested inside another type literal
                let ancestor: ts.Node | undefined = parent.parent;
                while (ancestor) {
                    if (ts.isTypeLiteralNode(ancestor)) {
                        return `nested ${prefix} type`;
                    }
                    if (ts.isTypeAliasDeclaration(ancestor)) {
                        return `nested ${prefix} type in type alias`;
                    }
                    ancestor = ancestor.parent;
                }
            }
            if (ts.isUnionTypeNode(parent) || ts.isIntersectionTypeNode(parent)) {
                return `${prefix} type in union/intersection`;
            }
            // Safely check parent.parent before accessing it
            if (parent.parent && ts.isTypeReferenceNode(parent.parent) && ts.isTypeNode(parent)) {
                return `${prefix} type in generic argument`;
            }
            // Direct parent is TypeReferenceNode (e.g., Prisma.GetPayload<{...}>)
            if (ts.isTypeReferenceNode(parent)) {
                return `${prefix} type in generic argument`;
            }
            if (ts.isArrayTypeNode(parent)) {
                return `${prefix} type in array`;
            }
            if (ts.isTupleTypeNode(parent) && !isTuple) {
                return `inline type in tuple`;
            }
            current = parent;
        }
        return isTuple ? 'tuple type' : 'inline type literal';
    } catch (error) {
        // Defensive: return generic context if AST traversal fails
        return ts.isTupleTypeNode(node) ? 'tuple type' : 'inline type literal';
    }
}

interface MethodInfo {
    name: string;
    startLine: number;
    endLine: number;
}

/**
 * Find all methods/functions in a file with their line ranges.
 */
// webpieces-disable max-lines-new-methods -- AST traversal requires inline visitor function
function findMethodsInFile(filePath: string, workspaceRoot: string): MethodInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
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
            methods.push({ name: methodName, startLine, endLine });
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return methods;
}

/**
 * Check if a line is within any method's range and if that method has changes.
 */
function isLineInChangedMethod(
    line: number,
    methods: MethodInfo[],
    changedLines: Set<number>,
    newMethodNames: Set<string>
): boolean {
    for (const method of methods) {
        if (line >= method.startLine && line <= method.endLine) {
            // Check if this method is new or has changes
            if (newMethodNames.has(method.name)) {
                return true;
            }
            // Check if any line in the method range has changes
            for (let l = method.startLine; l <= method.endLine; l++) {
                if (changedLines.has(l)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Check if a line is within a new method.
 */
function isLineInNewMethod(line: number, methods: MethodInfo[], newMethodNames: Set<string>): boolean {
    for (const method of methods) {
        if (line >= method.startLine && line <= method.endLine && newMethodNames.has(method.name)) {
            return true;
        }
    }
    return false;
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

interface InlineTypeInfo {
    line: number;
    column: number;
    context: string;
    hasDisableComment: boolean;
}

/**
 * Find all inline type literals AND tuple types in a file.
 *
 * Detects:
 *   - TypeLiteral nodes: { x: number }
 *   - TupleType nodes: [A, B]
 *
 * Both are flagged unless they are the DIRECT body of a type alias.
 */
// webpieces-disable max-lines-new-methods -- AST traversal with visitor pattern
function findInlineTypesInFile(filePath: string, workspaceRoot: string): InlineTypeInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const inlineTypes: InlineTypeInfo[] = [];

    function visit(node: ts.Node): void {
        try {
            // Check for inline type literals: { x: number }
            if (ts.isTypeLiteralNode(node)) {
                if (!isInAllowedContext(node)) {
                    const startPos = node.getStart(sourceFile);
                    if (startPos >= 0) {
                        const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                        const line = pos.line + 1;
                        const column = pos.character + 1;
                        const context = getViolationContext(node, sourceFile);
                        const disabled = hasDisableComment(fileLines, line);

                        inlineTypes.push({
                            line,
                            column,
                            context,
                            hasDisableComment: disabled,
                        });
                    }
                }
            }

            // Check for tuple types: [A, B]
            if (ts.isTupleTypeNode(node)) {
                if (!isInAllowedContext(node)) {
                    const startPos = node.getStart(sourceFile);
                    if (startPos >= 0) {
                        const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                        const line = pos.line + 1;
                        const column = pos.character + 1;
                        const context = getViolationContext(node, sourceFile);
                        const disabled = hasDisableComment(fileLines, line);

                        inlineTypes.push({
                            line,
                            column,
                            context,
                            hasDisableComment: disabled,
                        });
                    }
                }
            }
        } catch (error) {
            // Skip nodes that cause errors during analysis
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return inlineTypes;
}

/**
 * Find violations in new methods only (NEW_METHODS mode).
 */
// webpieces-disable max-lines-new-methods -- File iteration with diff parsing and method matching
function findViolationsForNewMethods(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head?: string
): InlineTypeViolation[] {
    const violations: InlineTypeViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);

        if (newMethodNames.size === 0) continue;

        const methods = findMethodsInFile(file, workspaceRoot);
        const inlineTypes = findInlineTypesInFile(file, workspaceRoot);

        for (const inlineType of inlineTypes) {
            if (inlineType.hasDisableComment) continue;
            if (!isLineInNewMethod(inlineType.line, methods, newMethodNames)) continue;

            violations.push({
                file,
                line: inlineType.line,
                column: inlineType.column,
                context: inlineType.context,
            });
        }
    }

    return violations;
}

/**
 * Find violations in new and modified methods (MODIFIED_AND_NEW_METHODS mode).
 */
// webpieces-disable max-lines-new-methods -- Combines new method detection with change detection
function findViolationsForModifiedAndNewMethods(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head?: string
): InlineTypeViolation[] {
    const violations: InlineTypeViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);
        const changedLines = getChangedLineNumbers(diff);

        const methods = findMethodsInFile(file, workspaceRoot);
        const inlineTypes = findInlineTypesInFile(file, workspaceRoot);

        for (const inlineType of inlineTypes) {
            if (inlineType.hasDisableComment) continue;
            if (!isLineInChangedMethod(inlineType.line, methods, changedLines, newMethodNames)) continue;

            violations.push({
                file,
                line: inlineType.line,
                column: inlineType.column,
                context: inlineType.context,
            });
        }
    }

    return violations;
}

/**
 * Find all violations in modified files (MODIFIED_FILES mode).
 */
function findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[]): InlineTypeViolation[] {
    const violations: InlineTypeViolation[] = [];

    for (const file of changedFiles) {
        const inlineTypes = findInlineTypesInFile(file, workspaceRoot);

        for (const inlineType of inlineTypes) {
            if (inlineType.hasDisableComment) continue;

            violations.push({
                file,
                line: inlineType.line,
                column: inlineType.column,
                context: inlineType.context,
            });
        }
    }

    return violations;
}

/**
 * Find all violations in all files (ALL mode).
 */
function findViolationsForAll(workspaceRoot: string): InlineTypeViolation[] {
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
function reportViolations(violations: InlineTypeViolation[], mode: NoInlineTypesMode): void {
    console.error('');
    console.error('❌ Inline type literals found! Use named types instead.');
    console.error('');
    console.error('📚 Named types improve code clarity and reusability:');
    console.error('');
    console.error('   BAD:  function foo(arg: { x: number }) { }');
    console.error('   GOOD: type MyConfig = { x: number };');
    console.error('         function foo(arg: MyConfig) { }');
    console.error('');
    console.error('   BAD:  type Nullable = { x: number } | null;');
    console.error('   GOOD: type MyData = { x: number };');
    console.error('         type Nullable = MyData | null;');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}:${v.column}`);
        console.error(`     ${v.context}`);
    }
    console.error('');

    console.error('   To fix: Extract inline types to named type aliases or interfaces');
    console.error('');
    console.error('   Escape hatch (use sparingly):');
    console.error('   // webpieces-disable no-inline-types -- [your reason]');
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

export default async function runExecutor(
    options: ValidateNoInlineTypesOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: NoInlineTypesMode = options.mode ?? 'OFF';

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping no-inline-types validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating No Inline Types\n');
    console.log(`   Mode: ${mode}`);

    let violations: InlineTypeViolation[] = [];

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
                console.log('\n⏭️  Skipping no-inline-types validation (could not detect base branch)');
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

        if (mode === 'NEW_METHODS') {
            violations = findViolationsForNewMethods(workspaceRoot, changedFiles, base, head);
        } else if (mode === 'MODIFIED_AND_NEW_METHODS') {
            violations = findViolationsForModifiedAndNewMethods(workspaceRoot, changedFiles, base, head);
        } else if (mode === 'MODIFIED_FILES') {
            violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles);
        }
    }

    if (violations.length === 0) {
        console.log('✅ No inline type literals found');
        return { success: true };
    }

    reportViolations(violations, mode);

    return { success: false };
}
