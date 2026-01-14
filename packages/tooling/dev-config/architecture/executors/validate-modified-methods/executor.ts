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
 * Escape hatch: Add webpieces-disable max-lines-modified comment with date and justification
 * Format: // webpieces-disable max-lines-modified 2025/01/15 -- [reason]
 * The disable expires after 1 month from the date specified.
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type ValidationMode = 'STRICT' | 'NORMAL' | 'OFF';

export interface ValidateModifiedMethodsOptions {
    max?: number;
    mode?: ValidationMode;
}

export interface ExecutorResult {
    success: boolean;
}

interface MethodViolation {
    file: string;
    methodName: string;
    line: number;
    lines: number;
    expiredDisable?: boolean;
    expiredDate?: string;
}

const TMP_DIR = 'tmp/webpieces';
const TMP_MD_FILE = 'webpieces.methodsize.md';

const METHODSIZE_DOC_CONTENT = `# Instructions: Method Too Long

## Requirement

**~50% of the time**, you can stay under the \`newMethodsMaxLines\` limit from nx.json
by extracting logical units into well-named methods.

**~99% of the time**, you can stay under the \`modifiedAndNewMethodsMaxLines\` limit from nx.json.
Nearly all software can be written with methods under this size.
Take the extra time to refactor - it's worth it for long-term maintainability.

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
- **New methods**: Must be under \`newMethodsMaxLines\` from nx.json
- **Modified methods**: Must be under \`modifiedAndNewMethodsMaxLines\` from nx.json
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

**Escape hatch**: Add a webpieces-disable comment with DATE and justification:

\`\`\`typescript
// webpieces-disable max-lines-modified 2025/01/15 -- Complex state machine, splitting reduces clarity
async complexStateMachine(): Promise<void> {
    // ... longer method with justification
}
\`\`\`

**IMPORTANT**: The date format is yyyy/mm/dd. The disable will EXPIRE after 1 month from this date.
After expiration, you must either fix the method or update the date to get another month.
This ensures that disable comments are reviewed periodically.

## AI Agent Action Steps

1. **READ** the method to understand its logical sections
2. **IDENTIFY** logical units that can be extracted
3. **EXTRACT** into well-named private methods
4. **VERIFY** the main method now reads like a table of contents
5. **IF NOT FEASIBLE**: Add webpieces-disable max-lines-modified comment with clear justification

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
 * Parse diff to find NEW method signatures.
 * Must handle: export function, async function, const/let arrow functions, class methods
 */
// webpieces-disable max-lines-new-methods -- Regex patterns require inline documentation
function findNewMethodSignaturesInDiff(diffContent: string): Set<string> {
    const newMethods = new Set<string>();
    const lines = diffContent.split('\n');

    // Patterns to match method definitions (same as validate-new-methods)
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
 * Parse a date string in yyyy/mm/dd format and return a Date object.
 * Returns null if the format is invalid.
 */
function parseDisableDate(dateStr: string): Date | null {
    // Match yyyy/mm/dd format
    const match = dateStr.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!match) return null;

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
    const day = parseInt(match[3], 10);

    const date = new Date(year, month, day);

    // Validate the date is valid (e.g., not Feb 30)
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
        return null;
    }

    return date;
}

/**
 * Check if a date is within the last month (not expired).
 */
function isDateWithinMonth(date: Date): boolean {
    const now = new Date();
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    return date >= oneMonthAgo;
}

/**
 * Get today's date in yyyy/mm/dd format for error messages
 */
function getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
}

interface DisableInfo {
    type: 'full' | 'new-only' | 'none';
    isExpired: boolean;
    date?: string;
}

/**
 * Check what kind of webpieces-disable comment is present for a method.
 * Returns: DisableInfo with type, expiration status, and date
 * - 'full': max-lines-modified (ultimate escape, skips both validators)
 * - 'new-only': max-lines-new-methods (escaped 30-line check, still needs 80-line check)
 * - 'none': no escape hatch
 */
// webpieces-disable max-lines-new-methods -- Complex validation logic with multiple escape hatch types
function getDisableInfo(lines: string[], lineNumber: number): DisableInfo {
    const startCheck = Math.max(0, lineNumber - 5);
    for (let i = lineNumber - 2; i >= startCheck; i--) {
        const line = lines[i]?.trim() ?? '';
        if (line.startsWith('function ') || line.startsWith('class ') || line.endsWith('}')) {
            break;
        }
        if (line.includes('webpieces-disable')) {
            if (line.includes('max-lines-modified')) {
                // Check for date in format: max-lines-modified yyyy/mm/dd
                const dateMatch = line.match(/max-lines-modified\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);

                if (!dateMatch) {
                    // No date found - treat as expired (invalid)
                    return { type: 'full', isExpired: true, date: undefined };
                }

                const dateStr = dateMatch[1];

                // Secret permanent disable
                if (dateStr === 'XXXX/XX/XX') {
                    return { type: 'full', isExpired: false, date: dateStr };
                }

                const date = parseDisableDate(dateStr);
                if (!date) {
                    // Invalid date format - treat as expired
                    return { type: 'full', isExpired: true, date: dateStr };
                }

                if (!isDateWithinMonth(date)) {
                    // Date is expired (older than 1 month)
                    return { type: 'full', isExpired: true, date: dateStr };
                }

                // Valid and not expired
                return { type: 'full', isExpired: false, date: dateStr };
            }
            if (line.includes('max-lines-new-methods')) {
                // Check for date in format: max-lines-new-methods yyyy/mm/dd
                const dateMatch = line.match(/max-lines-new-methods\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);

                if (!dateMatch) {
                    // No date found - treat as expired (invalid)
                    return { type: 'new-only', isExpired: true, date: undefined };
                }

                const dateStr = dateMatch[1];

                // Secret permanent disable
                if (dateStr === 'XXXX/XX/XX') {
                    return { type: 'new-only', isExpired: false, date: dateStr };
                }

                const date = parseDisableDate(dateStr);
                if (!date) {
                    // Invalid date format - treat as expired
                    return { type: 'new-only', isExpired: true, date: dateStr };
                }

                if (!isDateWithinMonth(date)) {
                    // Date is expired (older than 1 month)
                    return { type: 'new-only', isExpired: true, date: dateStr };
                }

                // Valid and not expired
                return { type: 'new-only', isExpired: false, date: dateStr };
            }
        }
    }
    return { type: 'none', isExpired: false };
}

interface MethodInfo {
    name: string;
    line: number;
    endLine: number;
    lines: number;
    disableInfo: DisableInfo;
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
                disableInfo: getDisableInfo(fileLines, startLine),
            });
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return methods;
}

/**
 * Check if a method has any changes within its line range
 */
function methodHasChanges(method: MethodInfo, changedLineNumbers: Set<number>): boolean {
    for (let line = method.line; line <= method.endLine; line++) {
        if (changedLineNumbers.has(line)) return true;
    }
    return false;
}

/**
 * Check a NEW method and return violation if applicable
 */
function checkNewMethodViolation(file: string, method: MethodInfo, mode: ValidationMode): MethodViolation | null {
    const { type: disableType, isExpired, date: disableDate } = method.disableInfo;

    if (mode === 'STRICT') {
        // When mode is STRICT, skip NEW methods without escape (let validate-new-methods handle)
        if (disableType === 'none') return null;
        return { file, methodName: method.name, line: method.line, lines: method.lines };
    }

    if (disableType === 'full' && isExpired) {
        return { file, methodName: method.name, line: method.line, lines: method.lines, expiredDisable: true, expiredDate: disableDate };
    }
    if (disableType !== 'new-only') return null;

    if (isExpired) {
        return { file, methodName: method.name, line: method.line, lines: method.lines, expiredDisable: true, expiredDate: disableDate };
    }
    return { file, methodName: method.name, line: method.line, lines: method.lines };
}

/**
 * Check a MODIFIED method and return violation if applicable
 */
function checkModifiedMethodViolation(file: string, method: MethodInfo, mode: ValidationMode): MethodViolation {
    const { type: disableType, isExpired, date: disableDate } = method.disableInfo;

    if (mode === 'STRICT') {
        return { file, methodName: method.name, line: method.line, lines: method.lines };
    }
    if (disableType === 'full' && isExpired) {
        return { file, methodName: method.name, line: method.line, lines: method.lines, expiredDisable: true, expiredDate: disableDate };
    }
    return { file, methodName: method.name, line: method.line, lines: method.lines };
}

/**
 * Find methods that exceed the 80-line limit.
 * Checks NEW methods with escape hatches and MODIFIED methods.
 */
function findViolations(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    maxLines: number,
    mode: ValidationMode,
    head?: string
): MethodViolation[] {
    const violations: MethodViolation[] = [];

    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        if (!diff) continue;

        const newMethodNames = findNewMethodSignaturesInDiff(diff);
        const changedLineNumbers = getChangedLineNumbers(diff);
        if (changedLineNumbers.size === 0) continue;

        const methods = findMethodsInFile(file, workspaceRoot);

        for (const method of methods) {
            const { type: disableType, isExpired } = method.disableInfo;

            // Skip methods with valid, non-expired full escape - unless mode is STRICT
            if (mode !== 'STRICT' && disableType === 'full' && !isExpired) continue;
            if (method.lines <= maxLines) continue;

            const isNewMethod = newMethodNames.has(method.name);

            if (isNewMethod) {
                const violation = checkNewMethodViolation(file, method, mode);
                if (violation) violations.push(violation);
            } else if (methodHasChanges(method, changedLineNumbers)) {
                violations.push(checkModifiedMethodViolation(file, method, mode));
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

/**
 * Report violations to console
 */
// webpieces-disable max-lines-new-methods -- Error output formatting with multiple message sections
function reportViolations(violations: MethodViolation[], maxLines: number, mode: ValidationMode): void {
    console.error('');
    console.error('❌ Modified methods exceed ' + maxLines + ' lines!');
    console.error('');
    console.error('📚 When you modify a method, you must bring it under ' + maxLines + ' lines.');
    console.error('   This rule encourages GRADUAL cleanup so even though you did not cause it,');
    console.error('   you touched it, so you should fix now as part of your PR');
    console.error('   (this is for vibe coding and AI to fix as it touches things).');
    console.error('   You can refactor to stay under the limit 50% of the time. If not feasible, use the escape hatch.');
    console.error('');
    console.error(
        '⚠️  *** READ tmp/webpieces/webpieces.methodsize.md for detailed guidance on how to fix this easily *** ⚠️'
    );
    console.error('');

    for (const v of violations) {
        if (v.expiredDisable) {
            console.error(`  ❌ ${v.file}:${v.line}`);
            console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${maxLines})`);
            console.error(`     ⏰ EXPIRED DISABLE: Your disable comment dated ${v.expiredDate ?? 'unknown'} has expired (>1 month old).`);
            console.error(`        You must either FIX the method or UPDATE the date to get another month.`);
        } else {
            console.error(`  ❌ ${v.file}:${v.line}`);
            console.error(`     Method: ${v.methodName} (${v.lines} lines, max: ${maxLines})`);
        }
    }
    console.error('');

    // Only show escape hatch instructions when mode is not STRICT
    if (mode !== 'STRICT') {
        console.error('   You can disable this error, but you will be forced to fix again in 1 month');
        console.error('   since 99% of methods can be less than ' + maxLines + ' lines of code.');
        console.error('');
        console.error('   Use escape with DATE (expires in 1 month):');
        console.error(`   // webpieces-disable max-lines-modified ${getTodayDateString()} -- [your reason]`);
        console.error('');
    } else {
        console.error('   ⚠️  validationMode is STRICT - disable comments are NOT allowed.');
        console.error('   You MUST refactor to reduce method size.');
        console.error('');
    }
}

export default async function runExecutor(
    options: ValidateModifiedMethodsOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const maxLines = options.max ?? 80;
    const mode: ValidationMode = options.mode ?? 'NORMAL';

    // Skip validation entirely if mode is OFF
    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping modified method validation (validationMode: OFF)');
        console.log('');
        return { success: true };
    }

    // If NX_HEAD is set (via nx affected --head=X), use it; otherwise compare to working tree
    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];

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
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log(`   Max lines for modified methods: ${maxLines}`);
    console.log(`   Validation mode: ${mode}${mode === 'STRICT' ? ' (disable comments ignored)' : ''}`);
    console.log('');

    try {
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base, head);

        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        const violations = findViolations(workspaceRoot, changedFiles, base, maxLines, mode, head);

        if (violations.length === 0) {
            console.log('✅ All modified methods are under ' + maxLines + ' lines');
            return { success: true };
        }

        writeTmpInstructions(workspaceRoot);
        reportViolations(violations, maxLines, mode);
        return { success: false };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Modified method validation failed:', error.message);
        return { success: false };
    }
}
