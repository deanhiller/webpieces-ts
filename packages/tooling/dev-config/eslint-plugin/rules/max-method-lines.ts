/**
 * ESLint rule to enforce maximum method length
 *
 * Enforces a configurable maximum line count for methods, functions, and arrow functions.
 * Default: 70 lines
 *
 * Configuration:
 * '@webpieces/max-method-lines': ['error', { max: 70 }]
 */

import type { Rule } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';

interface MethodLinesOptions {
    max: number;
}

interface FunctionNode {
    type:
        | 'FunctionDeclaration'
        | 'FunctionExpression'
        | 'ArrowFunctionExpression'
        | 'MethodDefinition';
    body?: any;
    loc?: {
        start: { line: number };
        end: { line: number };
    };
    key?: {
        name?: string;
    };
    id?: {
        name?: string;
    };
    [key: string]: any;
}

const METHOD_DOC_CONTENT = `# AI Agent Instructions: Method Too Long

**READ THIS FILE to fix methods that are too long**

## Core Principle
Every method should read like a TABLE OF CONTENTS of a book.
- Each method call is a "chapter"
- When you dive into a method, you find another table of contents
- Keeping methods under 70 lines is achievable with proper extraction

## Command: Extract Code into Named Methods

### Pattern 1: Extract Loop Bodies
\`\`\`typescript
// BAD: 50 lines embedded in loop
for (const order of orders) {
  // 20 lines of validation logic
  // 15 lines of processing logic
  // 10 lines of notification logic
}

// GOOD: Extracted to named methods
for (const order of orders) {
  validateOrder(order);
  processOrderItems(order);
  sendNotifications(order);
}
\`\`\`

### Pattern 2: Try-Catch Wrapper for Exception Handling
\`\`\`typescript
// GOOD: Separates success path from error handling
async function handleRequest(req: Request): Promise<Response> {
  try {
    return await executeRequest(req);
  } catch (err: unknown) {
    const error = toError(err);
    return createErrorResponse(error);
  }
}
\`\`\`

### Pattern 3: Sequential Method Calls (Table of Contents)
\`\`\`typescript
// GOOD: Self-documenting steps
function processOrder(order: Order): void {
  validateOrderData(order);
  calculateTotals(order);
  applyDiscounts(order);
  processPayment(order);
  updateInventory(order);
  sendConfirmation(order);
}
\`\`\`

### Pattern 4: Separate Data Object Creation
\`\`\`typescript
// BAD: 15 lines of inline object creation
doSomething({ field1: ..., field2: ..., field3: ..., /* 15 more fields */ });

// GOOD: Extract to factory method
const request = createRequestObject(data);
doSomething(request);
\`\`\`

### Pattern 5: Extract Inline Logic to Named Functions
\`\`\`typescript
// BAD: Complex inline logic
if (user.role === 'admin' && user.permissions.includes('write') && !user.suspended) {
  // 30 lines of admin logic
}

// GOOD: Extract to named methods
if (isAdminWithWriteAccess(user)) {
  performAdminOperation(user);
}
\`\`\`

## AI Agent Action Steps

1. **IDENTIFY** the long method in the error message
2. **READ** the method to understand its logical sections
3. **EXTRACT** logical units into separate methods with descriptive names
4. **REPLACE** inline code with method calls
5. **VERIFY** each extracted method is <70 lines
6. **TEST** that functionality remains unchanged

## Examples of "Logical Units" to Extract
- Validation logic -> \`validateX()\`
- Data transformation -> \`transformXToY()\`
- API calls -> \`fetchXFromApi()\`
- Object creation -> \`createX()\`
- Loop bodies -> \`processItem()\`
- Error handling -> \`handleXError()\`

Remember: Methods should read like a table of contents. Each line should be a "chapter title" (method call) that describes what happens, not how it happens.
`;

// Module-level flag to prevent redundant file creation
let methodDocCreated = false;

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
            } catch (err: unknown) {
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
    } catch (err: unknown) {
        // Graceful degradation: log warning but don't break lint
        console.warn(`[webpieces] Could not create doc file: ${docPath}`, err);
        return false;
    }
}

function ensureMethodDoc(context: Rule.RuleContext): void {
    if (methodDocCreated) return; // Performance: only create once per lint run

    const workspaceRoot = getWorkspaceRoot(context);
    const docPath = path.join(workspaceRoot, 'tmp', 'webpieces', 'webpieces.methods.md');

    if (ensureDocFile(docPath, METHOD_DOC_CONTENT)) {
        methodDocCreated = true;
    }
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Enforce maximum method length',
            category: 'Best Practices',
            recommended: false,
            url: 'https://github.com/deanhiller/webpieces-ts',
        },
        messages: {
            tooLong:
                'AI Agent: READ tmp/webpieces/webpieces.methods.md for fix instructions. Method "{{name}}" has {{actual}} lines (max: {{max}})',
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
        const options = context.options[0] as MethodLinesOptions | undefined;
        const maxLines = options?.max ?? 70;

        function checkFunction(node: any): void {
            ensureMethodDoc(context);

            const funcNode = node as FunctionNode;

            // Skip if this is a function expression that's part of a method definition
            // (method definitions will be handled by checkMethod)
            if (
                funcNode.type === 'FunctionExpression' &&
                funcNode['parent']?.type === 'MethodDefinition'
            ) {
                return;
            }

            // Skip if no location info or no body
            if (!funcNode.loc || !funcNode.body) {
                return;
            }

            // Get function name
            let name = 'anonymous';
            if (funcNode.type === 'FunctionDeclaration' && funcNode.id?.name) {
                name = funcNode.id.name;
            } else if (funcNode.type === 'FunctionExpression' && funcNode.id?.name) {
                name = funcNode.id.name;
            }

            // Calculate line count
            const startLine = funcNode.loc.start.line;
            const endLine = funcNode.loc.end.line;
            const lineCount = endLine - startLine + 1;

            if (lineCount > maxLines) {
                context.report({
                    node: funcNode as any,
                    messageId: 'tooLong',
                    data: {
                        name,
                        actual: String(lineCount),
                        max: String(maxLines),
                    },
                });
            }
        }

        function checkMethod(node: any): void {
            ensureMethodDoc(context);

            const methodNode = node;

            // Skip if no location info
            if (!methodNode.loc || !methodNode.value) {
                return;
            }

            // Get method name from key
            const name = methodNode.key?.name || 'anonymous';

            // Calculate line count for the method (including the method definition)
            const startLine = methodNode.loc.start.line;
            const endLine = methodNode.loc.end.line;
            const lineCount = endLine - startLine + 1;

            if (lineCount > maxLines) {
                context.report({
                    node: methodNode as any,
                    messageId: 'tooLong',
                    data: {
                        name,
                        actual: String(lineCount),
                        max: String(maxLines),
                    },
                });
            }
        }

        return {
            FunctionDeclaration: checkFunction,
            FunctionExpression: checkFunction,
            ArrowFunctionExpression: checkFunction,
            MethodDefinition: checkMethod,
        };
    },
};

export = rule;
