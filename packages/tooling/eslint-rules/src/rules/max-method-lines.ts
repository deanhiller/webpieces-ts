/**
 * ESLint rule to enforce maximum method length
 *
 * Enforces a configurable maximum line count for methods, functions, and arrow functions.
 * Default: 70 lines
 *
 * Configuration:
 * '@webpieces/max-method-lines': ['error', { max: 70 }]
 *
 * WHY the test-container carve-out exists:
 * In a spec file, `describe('...', () => { ... })` is a CONTAINER, not a unit of logic. Its
 * length only says "how many cases does this behaviour need", so counting it as an anonymous
 * method made agents split describe blocks purely to satisfy a limit written for production
 * methods - inventing structure that maps to nothing. So in TEST FILES ONLY, the callback
 * passed directly to a test-container call (describe/suite/context, incl. .each/.only/.skip)
 * is not counted.
 *
 * Deliberately NOT exempt (the rule's real purpose is untouched):
 *   - every `it(...)` / `test(...)` body - a 200-line test case IS worth flagging
 *   - `beforeEach` / `beforeAll` / `afterEach` / `afterAll` - those are logic, not containers
 *   - named helper functions inside spec files
 *   - anything whatsoever in a non-test file - production code is unaffected
 *
 * Full configuration (both extras optional, defaults shown):
 * '@webpieces/max-method-lines': ['error', {
 *     max: 70,
 *     testContainers: ['describe', 'suite', 'context'],
 *     testFilePattern: '\\.(spec|test)\\.[cm]?[jt]sx?$',
 * }]
 */

import type { Rule } from 'eslint';
import { writeTemplateIfMissing } from '@webpieces/rules-config';
import { toError } from '../toError';
import { EslintWorkspaceRoot } from '../workspace-root';
import { TestContainerPolicy, DEFAULT_TEST_CONTAINERS, DEFAULT_TEST_FILE_PATTERN } from '../test-container-policy';

const INSTRUCT_FILE = 'webpieces.methods.md';
const workspace = new EslintWorkspaceRoot();

interface MethodLinesOptions {
    max: number;
    testContainers?: string[];
    testFilePattern?: string;
}

// webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
interface FunctionNode {
    type:
        | 'FunctionDeclaration'
        | 'FunctionExpression'
        | 'ArrowFunctionExpression'
        | 'MethodDefinition';
    // webpieces-disable no-any-unknown -- ESTree AST dynamic body
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
    // webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
    [key: string]: any;
}

interface CheckerContext {
    context: Rule.RuleContext;
    maxLines: number;
    testContainerPolicy: TestContainerPolicy;
    filename: string;
}

// Module-level flag to prevent redundant file creation
let methodDocCreated = false;

function ensureMethodDoc(context: Rule.RuleContext): void {
    if (methodDocCreated) return;
    const workspaceRoot = workspace.workspaceRoot(context);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplateIfMissing(workspaceRoot, INSTRUCT_FILE);
        methodDocCreated = true;
    } catch (err: unknown) {
        const error = toError(err);
        console.warn('[webpieces] Could not write webpieces.methods.md', error);
    }
}

function getFunctionName(funcNode: FunctionNode): string {
    if (funcNode.type === 'FunctionDeclaration' && funcNode.id?.name) {
        return funcNode.id.name;
    }
    if (funcNode.type === 'FunctionExpression' && funcNode.id?.name) {
        return funcNode.id.name;
    }
    return 'anonymous';
}

// webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
function reportTooLong(ctx: CheckerContext, node: any, name: string, lineCount: number): void {
    ctx.context.report({
        node,
        messageId: 'tooLong',
        data: {
            name,
            actual: String(lineCount),
            max: String(ctx.maxLines),
        },
    });
}

// webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
function checkFunctionNode(ctx: CheckerContext, node: any): void {
    ensureMethodDoc(ctx.context);
    const funcNode = node as FunctionNode;

    // Skip function expressions inside method definitions
    if (funcNode.type === 'FunctionExpression' && funcNode['parent']?.type === 'MethodDefinition') {
        return;
    }

    if (!funcNode.loc || !funcNode.body) return;

    // describe(...)/suite(...) callbacks in spec files are containers, not units of logic.
    if (ctx.testContainerPolicy.isExemptContainerCallback(ctx.filename, funcNode)) {
        return;
    }

    const name = getFunctionName(funcNode);
    const lineCount = funcNode.loc.end.line - funcNode.loc.start.line + 1;

    if (lineCount > ctx.maxLines) {
        reportTooLong(ctx, funcNode, name, lineCount);
    }
}

// webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
function checkMethodNode(ctx: CheckerContext, node: any): void {
    ensureMethodDoc(ctx.context);

    if (!node.loc || !node.value) return;

    const name = node.key?.name || 'anonymous';
    const lineCount = node.loc.end.line - node.loc.start.line + 1;

    if (lineCount > ctx.maxLines) {
        reportTooLong(ctx, node, name, lineCount);
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
                'AI Agent: READ .webpieces/instruct-ai/webpieces.methods.md (at the repo root) for fix instructions. Method "{{name}}" has {{actual}} lines (max: {{max}})',
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
                    // Test-framework CONTAINER calls whose callback is not counted, in test
                    // files only. Do NOT add 'it'/'test'/'beforeEach' here - those bodies are
                    // logic and a long one is a real finding.
                    testContainers: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    // Which files count as test files for the carve-out above.
                    testFilePattern: {
                        type: 'string',
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const options = context.options[0] as MethodLinesOptions | undefined;
        const ctx: CheckerContext = {
            context,
            maxLines: options?.max ?? 70,
            // ESLint 9 exposes context.filename; older versions only getFilename().
            filename: context.filename ?? context.getFilename() ?? '',
            testContainerPolicy: new TestContainerPolicy(
                options?.testContainers ?? DEFAULT_TEST_CONTAINERS,
                options?.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN
            ),
        };

        return {
            FunctionDeclaration: (node) => checkFunctionNode(ctx, node),
            FunctionExpression: (node) => checkFunctionNode(ctx, node),
            ArrowFunctionExpression: (node) => checkFunctionNode(ctx, node),
            MethodDefinition: (node) => checkMethodNode(ctx, node),
        };
    },
};

export = rule;
