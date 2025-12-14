/**
 * Validate New Methods Executor
 *
 * Validates that newly added methods don't exceed a maximum line count.
 * Only runs when NX_BASE environment variable is set (affected mode).
 *
 * This validator encourages writing methods that read like a "table of contents"
 * where each method call describes a larger piece of work.
 *
 * Usage:
 * nx affected --target=validate-new-methods --base=origin/main
 *
 * Escape hatch: Add eslint-disable comment with justification
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

## The "Table of Contents" Principle

Good code reads like a book's table of contents:
- Chapter titles (method names) tell you WHAT happens
- Reading chapter titles gives you the full story
- You can dive into chapters (implementations) for details

## Why Limit New Methods to 20-30 Lines?

Methods under 20-30 lines are:
- Easy to review in a single screen
- Simple to understand without scrolling
- Quick for AI to analyze and suggest improvements
- More testable in isolation
- Self-documenting through well-named extracted methods

**~50% of the time**, you can stay under 20-30 lines in new code by extracting
logical units into well-named methods. This makes code more readable for both
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

**Escape hatch**: Add an eslint-disable comment with justification:

\`\`\`typescript
// eslint-disable-next-line @webpieces/max-method-lines -- Complex state machine, splitting reduces clarity
async complexStateMachine(): Promise<void> {
    // ... longer method with justification
}
\`\`\`

## AI Agent Action Steps

1. **READ** the method to understand its logical sections
2. **IDENTIFY** logical units that can be extracted
3. **EXTRACT** into well-named private methods
4. **VERIFY** the main method now reads like a table of contents
5. **IF NOT FEASIBLE**: Add eslint-disable with clear justification

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
function getChangedTypeScriptFiles(workspaceRoot: string, base: string, head: string): string[] {
    try {
        const output = execSync(`git diff --name-only ${base}...${head} -- '*.ts' '*.tsx'`, {
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
function getFileDiff(workspaceRoot: string, file: string, base: string, head: string): string {
    try {
        return execSync(`git diff ${base}...${head} -- "${file}"`, {
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
        // async methodName( or methodName(
        /^\+\s*(async\s+)?(\w+)\s*\(/,
        // function methodName(
        /^\+\s*(async\s+)?function\s+(\w+)\s*\(/,
        // const/let methodName = (async)? (
        /^\+\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
        // const/let methodName = (async)? function
        /^\+\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/,
    ];

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    // Extract method name from different capture groups
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
 * Parse a TypeScript file and find methods with their line counts
 */
function findMethodsInFile(
    filePath: string,
    workspaceRoot: string
): Array<{ name: string; line: number; lines: number }> {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const methods: Array<{ name: string; line: number; lines: number }> = [];

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
    head: string,
    maxLines: number
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
            // Only check NEW methods
            if (newMethodNames.has(method.name) && method.lines > maxLines) {
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

export default async function runExecutor(
    options: ValidateNewMethodsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const maxLines = options.max ?? 30;

    // Check if running in affected mode
    const base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'] || 'HEAD';

    if (!base) {
        console.log('\n⏭️  Skipping new method validation (not in affected mode)');
        console.log('   To run: nx affected --target=validate-new-methods --base=origin/main');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating New Method Sizes\n');
    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head}`);
    console.log(`   Max lines for new methods: ${maxLines}`);
    console.log('');

    try {
        // Get changed TypeScript files
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        // Find violations
        const violations = findViolations(workspaceRoot, changedFiles, base, head, maxLines);

        if (violations.length === 0) {
            console.log('✅ All new methods are under ' + maxLines + ' lines');
            return { success: true };
        }

        // Write instructions file
        const mdPath = writeTmpInstructions(workspaceRoot);

        // Report violations
        console.error('');
        console.error('❌ New methods exceed ' + maxLines + ' lines!');
        console.error('');
        console.error('📚 Methods should read like a "table of contents" - each method call');
        console.error('   describes a larger piece of work. ~50% of the time, you can refactor');
        console.error('   to stay under ' + maxLines + ' lines. If not feasible, use the escape hatch.');
        console.error('');

        for (const v of violations) {
            console.error(`  ❌ ${v.file}:${v.line}`);
            console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${maxLines})`);
            console.error(`     READ ${mdPath} to fix this error properly`);
            console.error('');
        }

        console.error('💡 To fix:');
        console.error('   1. Refactor the method to read like a table of contents (preferred)');
        console.error('   2. OR add eslint-disable comment with justification:');
        console.error('      // eslint-disable-next-line @webpieces/max-method-lines -- [reason]');
        console.error('');
        console.error(`⚠️  *** READ ${mdPath} for detailed guidance *** ⚠️`);
        console.error('');

        return { success: false };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ New method validation failed:', error.message);
        return { success: false };
    }
}
