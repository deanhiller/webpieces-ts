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
import { writeTemplateIfMissing } from '@webpieces/rules-config';
import { toError } from '../toError';

interface MethodLinesOptions {
    max: number;
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
}

// Module-level flag to prevent redundant file creation
let methodDocCreated = false;

function getWorkspaceRoot(context: Rule.RuleContext): string {
    const filename = context.filename || context.getFilename();
    let dir = path.dirname(filename);

    while (dir !== path.dirname(dir)) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return dir;
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err;
            }
        }
        dir = path.dirname(dir);
    }
    return process.cwd();
}

function ensureMethodDoc(context: Rule.RuleContext): void {
    if (methodDocCreated) return;
    const workspaceRoot = getWorkspaceRoot(context);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplateIfMissing(workspaceRoot, 'webpieces.methods.md');
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
                'AI Agent: READ .webpieces/instruct-ai/webpieces.methods.md for fix instructions. Method "{{name}}" has {{actual}} lines (max: {{max}})',
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
        const ctx: CheckerContext = { context, maxLines: options?.max ?? 70 };

        return {
            FunctionDeclaration: (node) => checkFunctionNode(ctx, node),
            FunctionExpression: (node) => checkFunctionNode(ctx, node),
            ArrowFunctionExpression: (node) => checkFunctionNode(ctx, node),
            MethodDefinition: (node) => checkMethodNode(ctx, node),
        };
    },
};

export = rule;
