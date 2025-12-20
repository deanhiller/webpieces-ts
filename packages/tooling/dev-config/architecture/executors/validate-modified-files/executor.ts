/**
 * Validate Modified Files Executor
 *
 * Validates that modified files don't exceed a maximum line count (default 900).
 * This encourages keeping files small and focused - when you touch a file,
 * you must bring it under the limit.
 *
 * Usage:
 * nx affected --target=validate-modified-files --base=origin/main
 *
 * Escape hatch: Add webpieces-disable max-lines-modified-files comment with date and justification
 * Format: // webpieces-disable max-lines-modified-files 2025/01/15 -- [reason]
 * The disable expires after 1 month from the date specified.
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateModifiedFilesOptions {
    max?: number;
}

export interface ExecutorResult {
    success: boolean;
}

interface FileViolation {
    file: string;
    lines: number;
    expiredDisable?: boolean;
    expiredDate?: string;
}

const TMP_DIR = 'tmp/webpieces';
const TMP_MD_FILE = 'webpieces.filesize.md';

const FILESIZE_DOC_CONTENT = `# AI Agent Instructions: File Too Long

**READ THIS FILE to fix files that are too long**

## Core Principle

With **stateless systems + dependency injection, refactor is trivial**.
Pick a method or a few and move to new class XXXXX, then inject XXXXX
into all users of those methods via the constructor.
Delete those methods from original class.

**99% of files can be less than the configured max lines of code.**

Files should contain a SINGLE COHESIVE UNIT.
- One class per file (Java convention)
- If class is too large, extract child responsibilities
- Use dependency injection to compose functionality

## Command: Reduce File Size

### Step 1: Check for Multiple Classes
If the file contains multiple classes, **SEPARATE each class into its own file**.

\`\`\`typescript
// BAD: UserController.ts (multiple classes)
export class UserController { /* ... */ }
export class UserValidator { /* ... */ }
export class UserNotifier { /* ... */ }

// GOOD: Three separate files
// UserController.ts
export class UserController { /* ... */ }

// UserValidator.ts
export class UserValidator { /* ... */ }

// UserNotifier.ts
export class UserNotifier { /* ... */ }
\`\`\`

### Step 2: Extract Child Responsibilities (if single class is too large)

#### Pattern: Create New Service Class with Dependency Injection

\`\`\`typescript
// BAD: UserController.ts (800 lines, single class)
@provideSingleton()
@Controller()
export class UserController {
  // 200 lines: CRUD operations
  // 300 lines: validation logic
  // 200 lines: notification logic
  // 100 lines: analytics logic
}

// GOOD: Extract validation service
// 1. Create UserValidationService.ts
@provideSingleton()
export class UserValidationService {
  validateUserData(data: UserData): ValidationResult {
    // 300 lines of validation logic moved here
  }

  validateEmail(email: string): boolean { /* ... */ }
  validatePassword(password: string): boolean { /* ... */ }
}

// 2. Inject into UserController.ts
@provideSingleton()
@Controller()
export class UserController {
  constructor(
    @inject(TYPES.UserValidationService)
    private validator: UserValidationService
  ) {}

  async createUser(data: UserData): Promise<User> {
    const validation = this.validator.validateUserData(data);
    if (!validation.isValid) {
      throw new ValidationError(validation.errors);
    }
    // ... rest of logic
  }
}
\`\`\`

## AI Agent Action Steps

1. **ANALYZE** the file structure:
   - Count classes (if >1, separate immediately)
   - Identify logical responsibilities within single class

2. **IDENTIFY** "child code" to extract:
   - Validation logic -> ValidationService
   - Notification logic -> NotificationService
   - Data transformation -> TransformerService
   - External API calls -> ApiService
   - Business rules -> RulesEngine

3. **CREATE** new service file(s):
   - Start with temporary name: \`XXXX.ts\` or \`ChildService.ts\`
   - Add \`@provideSingleton()\` decorator
   - Move child methods to new class

4. **UPDATE** dependency injection:
   - Add to \`TYPES\` constants (if using symbol-based DI)
   - Inject new service into original class constructor
   - Replace direct method calls with \`this.serviceName.method()\`

5. **RENAME** extracted file:
   - Read the extracted code to understand its purpose
   - Rename \`XXXX.ts\` to logical name (e.g., \`UserValidationService.ts\`)

6. **VERIFY** file sizes:
   - Original file should now be under the limit
   - Each extracted file should be under the limit
   - If still too large, extract more services

## Examples of Child Responsibilities to Extract

| If File Contains | Extract To | Pattern |
|-----------------|------------|---------|
| Validation logic (200+ lines) | \`XValidator.ts\` or \`XValidationService.ts\` | Singleton service |
| Notification logic (150+ lines) | \`XNotifier.ts\` or \`XNotificationService.ts\` | Singleton service |
| Data transformation (200+ lines) | \`XTransformer.ts\` | Singleton service |
| External API calls (200+ lines) | \`XApiClient.ts\` | Singleton service |
| Complex business rules (300+ lines) | \`XRulesEngine.ts\` | Singleton service |
| Database queries (200+ lines) | \`XRepository.ts\` | Singleton service |

## WebPieces Dependency Injection Pattern

\`\`\`typescript
// 1. Define service with @provideSingleton
import { provideSingleton } from '@webpieces/http-routing';

@provideSingleton()
export class MyService {
  doSomething(): void { /* ... */ }
}

// 2. Inject into consumer
import { inject } from 'inversify';
import { TYPES } from './types';

@provideSingleton()
@Controller()
export class MyController {
  constructor(
    @inject(TYPES.MyService) private service: MyService
  ) {}
}
\`\`\`

## Escape Hatch

If refactoring is genuinely not feasible (generated files, complex algorithms, etc.),
add a disable comment at the TOP of the file (within first 5 lines) with a DATE:

\`\`\`typescript
// webpieces-disable max-lines-modified-files 2025/01/15 -- Complex generated file, refactoring would break generation
\`\`\`

**IMPORTANT**: The date format is yyyy/mm/dd. The disable will EXPIRE after 1 month from this date.
After expiration, you must either fix the file or update the date to get another month.
This ensures that disable comments are reviewed periodically.

Remember: Find the "child code" and pull it down into a new class. Once moved, the code's purpose becomes clear, making it easy to rename to a logical name.
`;

/**
 * Write the instructions documentation to tmp directory
 */
function writeTmpInstructions(workspaceRoot: string): string {
    const tmpDir = path.join(workspaceRoot, TMP_DIR);
    const mdPath = path.join(tmpDir, TMP_MD_FILE);

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(mdPath, FILESIZE_DOC_CONTENT);

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

interface DisableStatus {
    hasDisable: boolean;
    isValid: boolean;
    isExpired: boolean;
    date?: string;
}

/**
 * Check if a file has a valid, non-expired disable comment at the top (within first 5 lines).
 * Returns status object with details about the disable comment.
 */
function checkDisableComment(content: string): DisableStatus {
    const lines = content.split('\n').slice(0, 5);

    for (const line of lines) {
        if (line.includes('webpieces-disable') && line.includes('max-lines-modified-files')) {
            // Found disable comment, now check for date
            // Format: // webpieces-disable max-lines-modified-files yyyy/mm/dd -- reason
            const dateMatch = line.match(/max-lines-modified-files\s+(\d{4}\/\d{2}\/\d{2}|XXXX\/XX\/XX)/);

            if (!dateMatch) {
                // No date found - invalid disable comment
                return { hasDisable: true, isValid: false, isExpired: false };
            }

            const dateStr = dateMatch[1];

            // Secret permanent disable
            if (dateStr === 'XXXX/XX/XX') {
                return { hasDisable: true, isValid: true, isExpired: false, date: dateStr };
            }

            const date = parseDisableDate(dateStr);
            if (!date) {
                // Invalid date format
                return { hasDisable: true, isValid: false, isExpired: false, date: dateStr };
            }

            if (!isDateWithinMonth(date)) {
                // Date is expired (older than 1 month)
                return { hasDisable: true, isValid: true, isExpired: true, date: dateStr };
            }

            // Valid and not expired
            return { hasDisable: true, isValid: true, isExpired: false, date: dateStr };
        }
    }

    return { hasDisable: false, isValid: false, isExpired: false };
}

/**
 * Count lines in a file and check for violations
 */
function findViolations(workspaceRoot: string, changedFiles: string[], maxLines: number): FileViolation[] {
    const violations: FileViolation[] = [];

    for (const file of changedFiles) {
        const fullPath = path.join(workspaceRoot, file);

        if (!fs.existsSync(fullPath)) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lineCount = content.split('\n').length;

        // Skip files under the limit
        if (lineCount <= maxLines) continue;

        // Check for disable comment
        const disableStatus = checkDisableComment(content);

        if (disableStatus.hasDisable) {
            if (disableStatus.isValid && !disableStatus.isExpired) {
                // Valid, non-expired disable - skip this file
                continue;
            }

            if (disableStatus.isExpired) {
                // Expired disable - report as violation with expired info
                violations.push({
                    file,
                    lines: lineCount,
                    expiredDisable: true,
                    expiredDate: disableStatus.date,
                });
                continue;
            }

            // Invalid disable (missing/bad date) - fall through to report as violation
        }

        violations.push({
            file,
            lines: lineCount,
        });
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
 * Get today's date in yyyy/mm/dd format for error messages
 */
function getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
}

export default async function runExecutor(
    options: ValidateModifiedFilesOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const maxLines = options.max ?? 900;

    let base = process.env['NX_BASE'];

    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;

        if (!base) {
            console.log('\n⏭️  Skipping modified files validation (could not detect base branch)');
            console.log('   To run explicitly: nx affected --target=validate-modified-files --base=origin/main');
            console.log('');
            return { success: true };
        }

        console.log('\n📏 Validating Modified File Sizes (auto-detected base)\n');
    } else {
        console.log('\n📏 Validating Modified File Sizes\n');
    }

    console.log(`   Base: ${base}`);
    console.log('   Comparing to: working tree (includes uncommitted changes)');
    console.log(`   Max lines for modified files: ${maxLines}`);
    console.log('');

    try {
        const changedFiles = getChangedTypeScriptFiles(workspaceRoot, base);

        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        const violations = findViolations(workspaceRoot, changedFiles, maxLines);

        if (violations.length === 0) {
            console.log('✅ All modified files are under ' + maxLines + ' lines');
            return { success: true };
        }

        // Write instructions file
        writeTmpInstructions(workspaceRoot);

        // Report violations
        console.error('');
        console.error('❌ YOU MUST FIX THIS AND NOT be more than ' + maxLines + ' lines of code per file');
        console.error('   as it slows down IDEs AND is VERY VERY EASY to refactor.');
        console.error('');
        console.error('📚 With stateless systems + dependency injection, refactor is trivial:');
        console.error('   Pick a method or a few and move to new class XXXXX, then inject XXXXX');
        console.error('   into all users of those methods via the constructor.');
        console.error('   Delete those methods from original class.');
        console.error('   99% of files can be less than ' + maxLines + ' lines of code.');
        console.error('');
        console.error('⚠️  *** READ tmp/webpieces/webpieces.filesize.md for detailed guidance on how to fix this easily *** ⚠️');
        console.error('');

        for (const v of violations) {
            if (v.expiredDisable) {
                console.error(`  ❌ ${v.file} (${v.lines} lines, max: ${maxLines})`);
                console.error(`     ⏰ EXPIRED DISABLE: Your disable comment dated ${v.expiredDate} has expired (>1 month old).`);
                console.error(`        You must either FIX the file or UPDATE the date to get another month.`);
            } else {
                console.error(`  ❌ ${v.file} (${v.lines} lines, max: ${maxLines})`);
            }
        }
        console.error('');

        console.error('   You can disable this error, but you will be forced to fix again in 1 month');
        console.error('   since 99% of files can be less than ' + maxLines + ' lines of code.');
        console.error('');
        console.error('   Use escape with DATE (expires in 1 month):');
        console.error(`   // webpieces-disable max-lines-modified-files ${getTodayDateString()} -- [your reason]`);
        console.error('');

        return { success: false };
    } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('❌ Modified files validation failed:', error.message);
        return { success: false };
    }
}
