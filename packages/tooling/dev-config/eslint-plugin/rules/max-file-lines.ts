/**
 * ESLint rule to enforce maximum file length
 *
 * Enforces a configurable maximum line count for files.
 * Default: 700 lines
 *
 * Configuration:
 * '@webpieces/max-file-lines': ['error', { max: 700 }]
 */

import type { Rule } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';

interface FileLinesOptions {
    max: number;
}

const FILE_DOC_CONTENT = `# AI Agent Instructions: File Too Long

**READ THIS FILE to fix files that are too long**

## Core Principle
Files should contain a SINGLE COHESIVE UNIT.
- One class per file (Java convention)
- If class is too large, extract child responsibilities
- Use dependency injection to compose functionality

## Command: Reduce File Size

### Step 1: Check for Multiple Classes
If the file contains multiple classes, **SEPARATE each class into its own file**.

\`\`\`typescript
// ❌ BAD: UserController.ts (multiple classes)
export class UserController { /* ... */ }
export class UserValidator { /* ... */ }
export class UserNotifier { /* ... */ }

// ✅ GOOD: Three separate files
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
// ❌ BAD: UserController.ts (800 lines, single class)
@provideSingleton()
@Controller()
export class UserController {
  // 200 lines: CRUD operations
  // 300 lines: validation logic
  // 200 lines: notification logic
  // 100 lines: analytics logic
}

// ✅ GOOD: Extract validation service
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
   - Validation logic → ValidationService
   - Notification logic → NotificationService
   - Data transformation → TransformerService
   - External API calls → ApiService
   - Business rules → RulesEngine

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
   - Original file should now be <700 lines
   - Each extracted file should be <700 lines
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

Remember: Find the "child code" and pull it down into a new class. Once moved, the code's purpose becomes clear, making it easy to rename to a logical name.
`;

// Module-level flag to prevent redundant file creation
let fileDocCreated = false;

function getWorkspaceRoot(context: Rule.RuleContext): string {
    const filename = context.filename || context.getFilename();
    let dir = path.dirname(filename);

    // Walk up directory tree to find workspace root
    while (dir !== path.dirname(dir)) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return dir;
                }
            } catch {
                // Continue searching if JSON parse fails
            }
        }
        dir = path.dirname(dir);
    }
    return process.cwd(); // Fallback
}

function ensureDocFile(docPath: string, content: string): boolean {
    try {
        fs.mkdirSync(path.dirname(docPath), { recursive: true });
        fs.writeFileSync(docPath, content, 'utf-8');
        return true;
    } catch (err) {
        // Graceful degradation: log warning but don't break lint
        console.warn(`[webpieces] Could not create doc file: ${docPath}`, err);
        return false;
    }
}

function ensureFileDoc(context: Rule.RuleContext): void {
    if (fileDocCreated) return; // Performance: only create once per lint run

    const workspaceRoot = getWorkspaceRoot(context);
    const docPath = path.join(workspaceRoot, 'tmp', 'webpieces', 'webpieces.filesize.md');

    if (ensureDocFile(docPath, FILE_DOC_CONTENT)) {
        fileDocCreated = true;
    }
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Enforce maximum file length',
            category: 'Best Practices',
            recommended: false,
            url: 'https://github.com/deanhiller/webpieces-ts',
        },
        messages: {
            tooLong:
                'AI Agent: READ tmp/webpieces/webpieces.filesize.md for fix instructions. File has {{actual}} lines (max: {{max}})',
        },
        fixable: undefined,
        schema: [
            {
                type: 'object',
                properties: {
                    max: {
                        type: 'integer',
                        minimum: 1,
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const options = context.options[0] as FileLinesOptions | undefined;
        const maxLines = options?.max ?? 700;

        return {
            Program(node: any): void {
                ensureFileDoc(context);

                const sourceCode = context.sourceCode || context.getSourceCode();
                const lines = sourceCode.lines;
                const lineCount = lines.length;

                if (lineCount > maxLines) {
                    context.report({
                        node,
                        messageId: 'tooLong',
                        data: {
                            actual: String(lineCount),
                            max: String(maxLines),
                        },
                    });
                }
            },
        };
    },
};

export = rule;
