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

export type MethodMaxLimitMode = 'OFF' | 'NEW_METHODS' | 'NEW_AND_MODIFIED_METHODS' | 'MODIFIED_FILES';

export interface ValidateNewMethodsOptions {
    limit?: number;
    mode?: MethodMaxLimitMode;
    disableAllowed?: boolean;
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
    limit: number;
}

interface MethodInfo {
    name: string;
    line: number;
    lines: number;
    hasDisableComment: boolean;
}

const TMP_DIR = 'tmp/webpieces';
const TMP_MD_FILE = 'webpieces.methodsize.md';

const METHODSIZE_DOC_CONTENT = `# Instructions: New Method Too Long

## Requirement

**~99% of the time**, you can stay under the \`limit\` from nx.json
by extracting logical units into well-named methods.
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
 * Get changed TypeScript files between base and head (or working tree if head not specified).
 * Uses `git diff base [head]` to match what `nx affected` does.
 * When head is NOT specified, also includes untracked files (matching nx affected behavior).
 */
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head?: string): string[] {
    try {
        // If head is specified, diff base to head; otherwise diff base to working tree
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget} -- '*.ts' '*.tsx'`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f) => f && !f.includes('.spec.ts') && !f.includes('.test.ts'));

        // When comparing to working tree (no head specified), also include untracked files
        // This matches what nx affected does: "All modified files not yet committed or tracked will also be added"
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
                // Merge and dedupe
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            } catch {
                // If ls-files fails, just return the changed files
                return changedFiles;
            }
        }

        return changedFiles;
    } catch {
        return [];
    }
}

/**
 * Get the diff content for a specific file between base and head (or working tree if head not specified).
 * Uses `git diff base [head]` to match what `nx affected` does.
 * For untracked files, returns the entire file content as additions.
 */
function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
    try {
        // If head is specified, diff base to head; otherwise diff base to working tree
        const diffTarget = head ? `${base} ${head}` : base;
        const diff = execSync(`git diff ${diffTarget} -- "${file}"`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });

        // If diff is empty and we're comparing to working tree, check if it's an untracked file
        if (!diff && !head) {
            const fullPath = path.join(workspaceRoot, file);
            if (fs.existsSync(fullPath)) {
                // Check if file is untracked
                const isUntracked = execSync(`git ls-files --others --exclude-standard "${file}"`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                }).trim();

                if (isUntracked) {
                    // For untracked files, treat entire content as additions
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const lines = content.split('\n');
                    // Create a pseudo-diff where all lines are additions
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
        // class method: [public/private/protected] [static] [async] methodName( - but NOT constructor, if, for, while, etc.
        /^\+\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
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
 * Both max-lines-new-methods AND max-lines-modified are accepted here.
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
            // Either escape hatch exempts from the lowLimit new method check
            if (line.includes('max-lines-new-methods') || line.includes('max-lines-modified')) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Parse a TypeScript file and find methods with their line counts
 */
// webpieces-disable max-lines-new-methods -- AST traversal requires inline visitor function
function findMethodsInFile(filePath: string, workspaceRoot: string): MethodInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const methods: MethodInfo[] = [];

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
    limit: number,
    disableAllowed: boolean,
    head?: string
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        // Get the diff to find which methods are NEW (not just modified)
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const newMethodNames = findNewMethodSignaturesInDiff(diff);

        if (newMethodNames.size === 0) continue;

        // Parse the current file to get method line counts
        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            if (!newMethodNames.has(method.name)) continue;

            if (method.lines > limit) {
                if (!disableAllowed) {
                    // No escape possible
                    violations.push({
                        file,
                        methodName: method.name,
                        line: method.line,
                        lines: method.lines,
                        isNew: true,
                        limit,
                    });
                } else if (!method.hasDisableComment) {
                    // Escape allowed but not present
                    violations.push({
                        file,
                        methodName: method.name,
                        line: method.line,
                        lines: method.lines,
                        isNew: true,
                        limit,
                    });
                }
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
function reportViolations(violations: MethodViolation[], limit: number, disableAllowed: boolean): void {
    console.error('');
    console.error('\u274c New methods exceed ' + limit + ' line limit!');
    console.error('');
    console.error('\ud83d\udcda Methods should read like a "table of contents" - each method call');
    console.error('   describes a larger piece of work.');
    console.error('');
    console.error('\u26a0\ufe0f  *** READ tmp/webpieces/webpieces.methodsize.md for detailed guidance on how to fix this easily *** \u26a0\ufe0f');
    console.error('');

    if (disableAllowed) {
        console.error('\u26a0\ufe0f  VIOLATIONS (can use escape hatch):');
    } else {
        console.error('\ud83d\udeab VIOLATIONS (cannot be bypassed with disable comment):');
    }
    console.error('');
    for (const v of violations) {
        console.error(`  \u274c ${v.file}:${v.line}`);
        console.error(`     Method: ${v.methodName} (${v.lines} lines, limit: ${limit})`);
    }
    console.error('');
    if (disableAllowed) {
        console.error('   Use escape: // webpieces-disable max-lines-new-methods -- [your reason]');
    } else {
        console.error('   These methods MUST be refactored - no escape hatch available (disableAllowed=false).');
    }
    console.error('');
}

export default async function runExecutor(
    options: ValidateNewMethodsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const limit = options.limit ?? 80;
    const mode: MethodMaxLimitMode = options.mode ?? 'NEW_AND_MODIFIED_METHODS';
    const disableAllowed = options.disableAllowed ?? true;

    // Skip validation entirely if mode is OFF
    if (mode === 'OFF') {
        console.log('\n\u23ed\ufe0f  Skipping new method validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    // Check if running in affected mode via NX_BASE, or auto-detect
    // If NX_HEAD is set (via nx affected --head=X), use it; otherwise compare to working tree
    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

    if (!base) {
        // Try to auto-detect base from git merge-base
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n\u23ed\ufe0f  Skipping new method validation (could not detect base branch)');
            console.log('   To run explicitly: nx affected --target=validate-new-methods --base=origin/main');
            console.log('');
            return { success: true };
        }

        console.log('\n\ud83d\udccf Validating New Method Sizes (auto-detected base)\n');
    } else {
        console.log('\n\ud83d\udccf Validating New Method Sizes\n');
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log(`   Mode: ${mode}`);
    console.log(`   Limit for new methods: ${limit} lines (${disableAllowed ? 'can escape' : 'NO escape possible'})`);
    console.log('');

    try {
        // Get changed TypeScript files (base to head, or working tree if head not set)
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('\u2705 No TypeScript files changed');
            return { success: true };
        }

        console.log(`\ud83d\udcc2 Checking ${changedFiles.length} changed file(s)...`);

        // Find violations
        const violations = findViolations(workspaceRoot, changedFiles, base, limit, disableAllowed, head);

        if (violations.length === 0) {
            console.log('\u2705 All new methods are within ' + limit + ' lines');
            return { success: true };
        }

        // Write instructions file and report violations
        writeTmpInstructions(workspaceRoot);
        reportViolations(violations, limit, disableAllowed);

        return { success: false };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('\u274c New method validation failed:', error.message);
        return { success: false };
    }
}
