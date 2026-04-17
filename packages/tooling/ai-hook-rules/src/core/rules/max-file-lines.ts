import * as fs from 'fs';
import * as path from 'path';

import type { FileRule, FileContext, Violation } from '../types';
import { Violation as V } from '../types';

const DEFAULT_LIMIT = 900;
const INSTRUCT_DIR = '.webpieces/instruct-ai';
const INSTRUCT_FILE = 'webpieces.filesize.md';

const maxFileLinesRule: FileRule = {
    name: 'max-file-lines',
    description: 'Cap file length at a configured line limit.',
    scope: 'file',
    files: ['**/*.ts', '**/*.tsx'],
    defaultOptions: { limit: DEFAULT_LIMIT },
    fixHint: [
        'READ .webpieces/instruct-ai/webpieces.filesize.md for step-by-step refactoring guidance.',
        '// eslint-disable-next-line @webpieces/max-file-lines  (also suppresses the eslint rule)',
    ],

    check(ctx: FileContext): readonly Violation[] {
        const limit = typeof ctx.options['limit'] === 'number'
            ? ctx.options['limit'] as number
            : DEFAULT_LIMIT;
        if (ctx.projectedFileLines <= limit) return [];
        writeInstructionFile(ctx.workspaceRoot);
        return [new V(
            1,
            `(projected ${String(ctx.projectedFileLines)} lines)`,
            `File will be ${String(ctx.projectedFileLines)} lines, exceeding the ${String(limit)}-line limit. See .webpieces/instruct-ai/webpieces.filesize.md for detailed refactoring instructions.`,
        )];
    },
};

function writeInstructionFile(workspaceRoot: string): void {
    const dir = path.join(workspaceRoot, INSTRUCT_DIR);
    const filePath = path.join(dir, INSTRUCT_FILE);
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, FILESIZE_DOC_CONTENT);
}

// eslint-disable-next-line @webpieces/max-file-lines
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
}

// GOOD: Extract validation service
// 1. Create UserValidationService.ts
@provideSingleton()
export class UserValidationService {
  validateUserData(data: UserData): ValidationResult { /* ... */ }
  validateEmail(email: string): boolean { /* ... */ }
}

// 2. Inject into UserController.ts
@provideSingleton()
@Controller()
export class UserController {
  constructor(
    @inject(TYPES.UserValidationService)
    private validator: UserValidationService
  ) {}
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
   - Add \`@provideSingleton()\` decorator
   - Move child methods to new class

4. **UPDATE** dependency injection:
   - Inject new service into original class constructor
   - Replace direct method calls with \`this.serviceName.method()\`

5. **VERIFY** file sizes:
   - Original file should now be under the limit
   - Each extracted file should be under the limit

## Escape Hatch

If refactoring is genuinely not feasible, add a disable comment:

\`\`\`typescript
// eslint-disable-next-line @webpieces/max-file-lines
\`\`\`

Remember: Find the "child code" and pull it down into a new class. Once moved, the code's purpose becomes clear, making it easy to rename to a logical name.
`;

export default maxFileLinesRule;
