/**
 * Validate Modified Methods Executor
 *
 * Validates that modified methods don't exceed a maximum line count (default 80).
 * This encourages gradual cleanup of legacy long methods - when you touch a method,
 * you must bring it under the limit.
 *
 * Combined with validate-new-methods (30 line limit), this creates a gradual
 * transition to cleaner code:
 * - New methods: strict 30 line limit
 * - Modified methods: lenient 80 line limit (cleanup when touched)
 * - Untouched methods: no limit (legacy allowed)
 *
 * Usage:
 * nx affected --target=validate-modified-methods --base=origin/main
 *
 * Escape hatch: Add webpieces-disable max-lines-modified-methods comment with justification
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export interface ValidateModifiedMethodsOptions {
    max?: number;
}

export interface ExecutorResult {
    success: boolean;
}

interface MethodViolation {
    file: string;
    methodName: string;
    line: number;
    lines: number;
}

const TMP_DIR = 'tmp/webpieces';
const TMP_MD_FILE = 'webpieces.methodsize.md';

const METHODSIZE_DOC_CONTENT = `# Instructions: Method Too Long

## The "Table of Contents" Principle

Good code reads like a book's table of contents:
- Chapter titles (method names) tell you WHAT happens
- Reading chapter titles gives you the full story
- You can dive into chapters (implementations) for details

## Why Limit Method Sizes?

Methods under reasonable limits are:
- Easy to review in a single screen
- Simple to understand without scrolling
- Quick for AI to analyze and suggest improvements
- More testable in isolation
- Self-documenting through well-named extracted methods

## Gradual Cleanup Strategy

This codebase uses a gradual cleanup approach:
- **New methods**: Must be under 30 lines (strict)
- **Modified methods**: Must be under 80 lines (when you touch it, clean it up)
- **Untouched methods**: No limit (legacy code is allowed until touched)

## How to Refactor

Instead of:
\`\`\`typescript
async processOrder(order: Order): Promise<Result> {
    // 100 lines of validation, transformation, saving, notifications...
}
\`\`\`

Write:
\`\`\`typescript
async processOrder(order: Order): Promise<Result> {
    const validated = this.validateOrder(order);
    const transformed = this.applyBusinessRules(validated);
    const saved = await this.saveToDatabase(transformed);
    await this.notifyStakeholders(saved);
    return this.buildResult(saved);
}
\`\`\`

Now the main method is a "table of contents" - each line tells part of the story!

## Patterns for Extraction

### Pattern 1: Extract Loop Bodies
\`\`\`typescript
// BEFORE
for (const item of items) {
    // 20 lines of processing
}

// AFTER
for (const item of items) {
    this.processItem(item);
}
\`\`\`

### Pattern 2: Extract Conditional Blocks
\`\`\`typescript
// BEFORE
if (isAdmin(user)) {
    // 15 lines of admin logic
}

// AFTER
if (isAdmin(user)) {
    this.handleAdminUser(user);
}
\`\`\`

### Pattern 3: Extract Data Transformations
\`\`\`typescript
// BEFORE
const result = {
    // 10+ lines of object construction
};

// AFTER
const result = this.buildResultObject(data);
\`\`\`

## If Refactoring Is Not Feasible

Sometimes methods genuinely need to be longer (complex algorithms, state machines, etc.).

**Escape hatch**: Add a webpieces-disable comment with justification:

\`\`\`typescript
// webpieces-disable max-lines-modified-methods -- Complex state machine, splitting reduces clarity
async complexStateMachine(): Promise<void> {
    // ... longer method with justification
}
\`\`\`

## AI Agent Action Steps

1. **READ** the method to understand its logical sections
2. **IDENTIFY** logical units that can be extracted
3. **EXTRACT** into well-named private methods
4. **VERIFY** the main method now reads like a table of contents
5. **IF NOT FEASIBLE**: Add webpieces-disable max-lines-modified-methods comment with clear justification

## Remember

- Every method you write today will be read many times tomorrow
- The best code explains itself through structure
- When in doubt, extract and name it
`;

/**
 * Write the instructions documentation to tmp directory
 */
function writeTmpInstructions(workspaceRoot: string): string {
    const tmpDir = path.join(workspaceRoot, TMP_DIR);
    const mdPath = path.join(tmpDir, TMP_MD_FILE);

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(mdPath, METHODSIZE_DOC_CONTENT);

    return mdPath;
}

/**
 * Get changed TypeScript files between base and head
 */
function getChangedTypeScriptFiles(workspaceRoot: string, base: string): string[] {
    try {
        const output = execSync(`git diff --name-only ${base}...HEAD -- '*.ts' '*.tsx'`, {
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
 * Get the diff content for a specific file
 */
function getFileDiff(workspaceRoot: string, file: string, base: string): string {
    try {
        return execSync(`git diff ${base}...HEAD -- "${file}"`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
    } catch {
        return '';
    }
}

/**
 * Parse diff to find NEW method signatures (to exclude from modified check)
 */
function findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
    const newMethods = new Set<string>();
    const lines = diffContent.split('\n');

    const patterns = [
        /^\+\s*(async\s+)?(\w+)\s*\(/,
        /^\+\s*(async\s+)?function\s+(\w+)\s*\(/,
        /^\+\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
        /^\+\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
    ];

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    const methodName = match[2] || match[1];
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
 * Parse diff to find line numbers that have changes in the new file
 */
function getChangedLineNumbers(diffContent: string): Set<number> {
    const changedLines = new Set<number>();
    const lines = diffContent.split('\n');

    let currentNewLine = 0;

    for (const line of lines) {
        // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            currentNewLine = parseInt(hunkMatch[1], 10);
            continue;
        }

        if (currentNewLine === 0) continue;

        if (line.startsWith('+') && !line.startsWith('+++')) {
            // Added line
            changedLines.add(currentNewLine);
            currentNewLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            // Removed line - doesn't increment new line counter
        } else if (!line.startsWith('\\')) {
            // Context line (unchanged)
            currentNewLine++;
        }
    }

    return changedLines;
}

/**
 * Check if a line contains a webpieces-disable comment for max-lines-modified-methods
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable') && line.includes('max-lines-modified-methods')) {
            return true;
        }
    }
    return false;
}

/**
 * Parse a TypeScript file and find methods with their line counts
 */
// webpieces-disable max-lines-new-methods -- AST traversal requires inline visitor function
function findMethodsInFile(
    filePath: string,
    workspaceRoot: string
): Array<{ name: string; line: number; endLine: number; lines: number; hasDisableComment: boolean }> {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const methods: Array<{ name: string; line: number; endLine: number; lines: number; hasDisableComment: boolean }> =
        [];

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
                hasDisableComment: hasDisableComment(fileLines, startLine),
            });
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return methods;
}

/**
 * Find modified methods that exceed the line limit
 * Modified = has changes within method body but is NOT a new method
 */
// webpieces-disable max-lines-new-methods -- Core validation logic with multiple file operations
function findViolations(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    maxLines: number
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base);
        if (!diff) continue;

        // Find NEW methods (to exclude)
        const newMethodNames = findNewMethodSignaturesInDiff(diff);

        // Find which lines have changes
        const changedLineNumbers = getChangedLineNumbers(diff);
        if (changedLineNumbers.size === 0) continue;

        // Parse the current file to get all methods
        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            // Skip new methods (handled by validate-new-methods)
            if (newMethodNames.has(method.name)) continue;

            // Skip methods with disable comment
            if (method.hasDisableComment) continue;

            // Skip methods under the limit
            if (method.lines <= maxLines) continue;

            // Check if any changed line falls within this method's range
            let hasChanges = false;
            for (let line = method.line; line <= method.endLine; line++) {
                if (changedLineNumbers.has(line)) {
                    hasChanges = true;
                    break;
                }
            }

            if (hasChanges) {
                violations.push({
                    file,
                    methodName: method.name,
                    line: method.line,
                    lines: method.lines,
                });
            }
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

export default async function runExecutor(
    options: ValidateModifiedMethodsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const maxLines = options.max ?? 80;

    let base = process.env['NX_BASE'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping modified method validation (could not detect base branch)');
            console.log('   To run explicitly: nx affected --target=validate-modified-methods --base=origin/main');
            console.log('');
            return { success: true };
        }

        console.log('\n📏 Validating Modified Method Sizes (auto-detected base)\n');
    } else {
        console.log('\n📏 Validating Modified Method Sizes\n');
    }

    console.log(`   Base: ${base}`);
    console.log('   Comparing to: working tree (includes uncommitted changes)');
    console.log(`   Max lines for modified methods: ${maxLines}`);
    console.log('');

    try {
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base);

        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        const violations = findViolations(workspaceRoot, changedFiles, base, maxLines);

        if (violations.length === 0) {
            console.log('✅ All modified methods are under ' + maxLines + ' lines');
            return { success: true };
        }

        // Write instructions file
        writeTmpInstructions(workspaceRoot);

        // Report violations
        console.error('');
        console.error('❌ Modified methods exceed ' + maxLines + ' lines!');
        console.error('');
        console.error('📚 When you modify a method, you must bring it under ' + maxLines + ' lines.');
        console.error('   This encourages gradual cleanup of legacy code.');
        console.error('   You can refactor to stay under the limit 50% of the time.');
        console.error('   If not feasible, use the escape hatch.');
        console.error('');
        console.error(
            '⚠️  *** READ tmp/webpieces/webpieces.methodsize.md for detailed guidance on how to fix this easily *** ⚠️'
        );
        console.error('');

        for (const v of violations) {
            console.error(`  ❌ ${v.file}:${v.line}`);
            console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${maxLines})`);
        }
        console.error('');

        return { success: false };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Modified method validation failed:', error.message);
        return { success: false };
    }
}
