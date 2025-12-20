/**
 * Validate New Methods Executor
 *
 * Validates that newly added methods don't exceed a maximum line count.
 * Runs in affected mode when:
 *   1. NX_BASE environment variable is set (via nx affected), OR
 *   2. Auto-detects base by finding merge-base with origin/main
 *
 * This validator encourages writing methods that read like a "table of contents"
 * where each method call describes a larger piece of work.
 *
 * Usage:
 * nx affected --target=validate-new-methods --base=origin/main
 * OR: runs automatically via build's architecture:validate-complete dependency
 *
 * Escape hatch: Add webpieces-disable max-lines-new-methods comment with justification
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export interface ValidateNewMethodsOptions {
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
    isNew: boolean;
}

const TMP_DIR = 'tmp/webpieces';
const TMP_MD_FILE = 'webpieces.methodsize.md';

const METHODSIZE_DOC_CONTENT = `# Instructions: New Method Too Long

## Requirement

**~50% of the time**, you can stay under the \`newMethodsMaxLines\` limit from nx.json
by extracting logical units into well-named methods.

**~99% of the time**, you can stay under the \`modifiedAndNewMethodsMaxLines\` limit from nx.json.
Nearly all software can be written with methods under this size.

## The "Table of Contents" Principle

Good code reads like a book's table of contents:
- Chapter titles (method names) tell you WHAT happens
- Reading chapter titles gives you the full story
- You can dive into chapters (implementations) for details

## Why Limit New Methods?

Methods under the limit are:
- Easy to review in a single screen
- Simple to understand without scrolling
- Quick for AI to analyze and suggest improvements
- More testable in isolation
- Self-documenting through well-named extracted methods

Extracting logical units into well-named methods makes code more readable for both
AI and humans.

## How to Refactor

Instead of:
\`\`\`typescript
async processOrder(order: Order): Promise<Result> {
    // 50 lines of validation, transformation, saving, notifications...
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
// webpieces-disable max-lines-new-methods -- Complex state machine, splitting reduces clarity
async complexStateMachine(): Promise<void> {
    // ... longer method with justification
}
\`\`\`

## AI Agent Action Steps

1. **READ** the method to understand its logical sections
2. **IDENTIFY** logical units that can be extracted
3. **EXTRACT** into well-named private methods
4. **VERIFY** the main method now reads like a table of contents
5. **IF NOT FEASIBLE**: Add webpieces-disable max-lines-new-methods comment with clear justification

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
 * Get changed TypeScript files between base and working tree.
 * Uses `git diff base` (no three-dots) to match what `nx affected` does -
 * this includes both committed and uncommitted changes in one diff.
 */
function getChangedTypeScriptFiles(workspaceRoot: string, base: string): string[] {
    try {
        // Use two-dot diff (base to working tree) - same as nx affected
        const output = execSync(`git diff --name-only ${base} -- '*.ts' '*.tsx'`, {
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
 * Get the diff content for a specific file between base and working tree.
 * Uses `git diff base` (no three-dots) to match what `nx affected` does -
 * this includes both committed and uncommitted changes in one diff.
 */
function getFileDiff(workspaceRoot: string, file: string, base: string): string {
    try {
        // Use two-dot diff (base to working tree) - same as nx affected
        return execSync(`git diff ${base} -- "${file}"`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
    } catch {
        return '';
    }
}

/**
 * Parse diff to find newly added method signatures
 */
function findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
    const newMethods = new Set<string>();
    const lines = diffContent.split('\n');

    // Patterns to match method definitions
    const patterns = [
        // [export] [async] function methodName( - most explicit, check first
        /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
        // [export] const/let methodName = [async] (
        /^\+\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
        // [export] const/let methodName = [async] function
        /^\+\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
        // class method: [async] methodName( - but NOT constructor, if, for, while, etc.
        /^\+\s*(?:async\s+)?(\w+)\s*\(/,
    ];

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    // Extract method name - now always in capture group 1
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
 * Check if a line contains a webpieces-disable comment that exempts from new method validation.
 * Both max-lines-new-methods AND max-lines-new-and-modified are accepted here.
 * - max-lines-new-methods: Exempts from 30-line check, still checked by 80-line validator
 * - max-lines-new-and-modified: Exempts from both validators (ultimate escape hatch)
 */
function hasDisableComment(lines: string[], lineNumber: number): boolean {
    // Check the line before the method (lineNumber is 1-indexed, array is 0-indexed)
    // We need to check a few lines before in case there's JSDoc or decorators
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        // Stop if we hit another function/class/etc
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable')) {
            // Either escape hatch exempts from the 30-line new method check
            if (line.includes('max-lines-new-methods') || line.includes('max-lines-new-and-modified')) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Parse a TypeScript file and find methods with their line counts
 */
function findMethodsInFile(
    filePath: string,
    workspaceRoot: string
): Array<{ name: string; line: number; lines: number; hasDisableComment: boolean }> {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const methods: Array<{ name: string; line: number; lines: number; hasDisableComment: boolean }> = [];

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
            // Check if it's assigned to a variable
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
 * Find new methods that exceed the line limit
 */
function findViolations(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    maxLines: number
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        // Get the diff to find which methods are NEW (not just modified)
        const diff = getFileDiff(workspaceRoot, file, base);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);

        if (newMethodNames.size === 0) continue;

        // Parse the current file to get method line counts
        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            // Only check NEW methods that don't have webpieces-disable comment
            if (newMethodNames.has(method.name) && method.lines > maxLines && !method.hasDisableComment) {
                violations.push({
                    file,
                    methodName: method.name,
                    line: method.line,
                    lines: method.lines,
                    isNew: true,
                });
            }
        }
    }

    return violations;
}

/**
 * Auto-detect the base branch by finding the merge-base with origin/main.
 * This allows the executor to run even when NX_BASE isn't set (e.g., via dependsOn).
 */
function detectBase(workspaceRoot: string): string | null {
    try {
        // First, try to get merge-base with origin/main
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    } catch {
        // origin/main might not exist, try main
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
            // Ignore - will return null
        }
    }
    return null;
}

/**
 * Report violations to the user with helpful instructions
 */
function reportViolations(violations: MethodViolation[], maxLines: number): void {
    console.error('');
    console.error('❌ New methods exceed ' + maxLines + ' lines!');
    console.error('');
    console.error('📚 Methods should read like a "table of contents" - each method call');
    console.error('   describes a larger piece of work. You can refactor');
    console.error('   to stay under ' + maxLines + ' lines 50% of the time.');
    console.error('');
    console.error('⚠️  *** READ tmp/webpieces/webpieces.methodsize.md for detailed guidance on how to fix this easily *** ⚠️');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${maxLines})`);
    }
    console.error('');
    console.error('   If you REALLY REALLY need more than ' + maxLines + ' lines, this happens 50% of the time,');
    console.error('   so use escape: // webpieces-disable max-lines-new-methods -- [your reason]');
    console.error('');
}

export default async function runExecutor(
    options: ValidateNewMethodsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const maxLines = options.max ?? 30;

    // Check if running in affected mode via NX_BASE, or auto-detect
    // We use NX_BASE as the base, and compare to WORKING TREE (not NX_HEAD)
    // This matches what `nx affected` does - it compares base to working tree
    let base = process.env['NX_BASE'];

    if (!base) {
        // Try to auto-detect base from git merge-base
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping new method validation (could not detect base branch)');
            console.log('   To run explicitly: nx affected --target=validate-new-methods --base=origin/main');
            console.log('');
            return { success: true };
        }

        console.log('\n📏 Validating New Method Sizes (auto-detected base)\n');
    } else {
        console.log('\n📏 Validating New Method Sizes\n');
    }

    console.log(`   Base: ${base}`);
    console.log(`   Comparing to: working tree (includes uncommitted changes)`);
    console.log(`   Max lines for new methods: ${maxLines}`);
    console.log('');

    try {
        // Get changed TypeScript files (base to working tree, like nx affected)
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base);

        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        // Find violations
        const violations = findViolations(workspaceRoot, changedFiles, base, maxLines);

        if (violations.length === 0) {
            console.log('✅ All new methods are under ' + maxLines + ' lines');
            return { success: true };
        }

        // Write instructions file and report violations
        writeTmpInstructions(workspaceRoot);
        reportViolations(violations, maxLines);

        return { success: false };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ New method validation failed:', error.message);
        return { success: false };
    }
}
