/**
 * ESLint rule to enforce standardized catch block error handling patterns
 *
 * Enforces three approved patterns:
 * 1. Standard: catch (err: unknown) { const error = toError(err); }
 * 2. Ignored: catch (err: unknown) { //const error = toError(err); }
 * 3. Nested: catch (err2: unknown) { const error2 = toError(err2); }
 */

import type { Rule } from 'eslint';

// Using any for ESTree nodes to avoid complex type gymnastics
// ESLint rules work with dynamic AST nodes anyway
interface CatchClauseNode {
    type: 'CatchClause';
    param?: IdentifierNode | null;
    body: BlockStatementNode;
    [key: string]: any;
}

interface IdentifierNode {
    type: 'Identifier';
    name: string;
    typeAnnotation?: TypeAnnotationNode;
    [key: string]: any;
}

interface TypeAnnotationNode {
    typeAnnotation?: {
        type: string;
    };
}

interface BlockStatementNode {
    type: 'BlockStatement';
    body: any[];
    range: [number, number];
    [key: string]: any;
}

interface VariableDeclarationNode {
    type: 'VariableDeclaration';
    declarations: VariableDeclaratorNode[];
    [key: string]: any;
}

interface VariableDeclaratorNode {
    type: 'VariableDeclarator';
    id: IdentifierNode;
    init?: CallExpressionNode | null;
    [key: string]: any;
}

interface CallExpressionNode {
    type: 'CallExpression';
    callee: IdentifierNode;
    arguments: any[];
    [key: string]: any;
}

function validateParamName(
    context: Rule.RuleContext,
    param: IdentifierNode,
    expectedParamName: string,
): void {
    if (param.type === 'Identifier' && param.name !== expectedParamName) {
        context.report({
            node: param,
            messageId: 'wrongParameterName',
            data: { actual: param.name },
        });
    }
}

function validateTypeAnnotation(
    context: Rule.RuleContext,
    param: IdentifierNode,
    expectedParamName: string,
): void {
    if (
        !param.typeAnnotation ||
        !param.typeAnnotation.typeAnnotation ||
        param.typeAnnotation.typeAnnotation.type !== 'TSUnknownKeyword'
    ) {
        context.report({
            node: param,
            messageId: 'missingTypeAnnotation',
            data: { param: param.name || expectedParamName },
        });
    }
}

function hasIgnoreComment(
    catchNode: CatchClauseNode,
    sourceCode: Rule.RuleContext['sourceCode'],
    expectedVarName: string,
    actualParamName: string,
): boolean {
    const catchBlockStart = catchNode.body.range![0];
    const catchBlockEnd = catchNode.body.range![1];
    const catchBlockText = sourceCode.text.substring(catchBlockStart, catchBlockEnd);

    const ignorePattern = new RegExp(
        `//\\s*const\\s+${expectedVarName}\\s*=\\s*toError\\(${actualParamName}\\)`,
    );

    return ignorePattern.test(catchBlockText);
}

function reportMissingToError(
    context: Rule.RuleContext,
    // webpieces-disable no-any-unknown -- ESLint AST node param requires any type
    node: any,
    paramName: string,
): void {
    context.report({
        node,
        messageId: 'missingToError',
        data: { param: paramName },
    });
}

function validateToErrorCall(
    context: Rule.RuleContext,
    // webpieces-disable no-any-unknown -- ESLint AST node param requires any type
    firstStatement: any,
    expectedParamName: string,
    expectedVarName: string,
    actualParamName: string,
): void {
    if (firstStatement.type !== 'VariableDeclaration') {
        reportMissingToError(context, firstStatement, expectedParamName);
        return;
    }

    const varDecl = firstStatement as VariableDeclarationNode;
    const declaration = varDecl.declarations[0];
    if (!declaration) {
        reportMissingToError(context, firstStatement, expectedParamName);
        return;
    }

    if (declaration.id.type !== 'Identifier' || declaration.id.name !== expectedVarName) {
        context.report({
            node: declaration.id,
            messageId: 'wrongVariableName',
            data: { expected: expectedVarName, actual: declaration.id.name || 'unknown' },
        });
        return;
    }

    if (!declaration.init || declaration.init.type !== 'CallExpression') {
        reportMissingToError(context, declaration.init || declaration, expectedParamName);
        return;
    }

    const callExpr = declaration.init as CallExpressionNode;
    const callee = callExpr.callee;
    if (callee.type !== 'Identifier' || callee.name !== 'toError') {
        reportMissingToError(context, callee, expectedParamName);
        return;
    }

    const args = callExpr.arguments;
    if (
        args.length !== 1 ||
        args[0].type !== 'Identifier' ||
        (args[0] as IdentifierNode).name !== actualParamName
    ) {
        reportMissingToError(context, callExpr, actualParamName);
    }
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Enforce standardized catch block error handling patterns',
            category: 'Best Practices',
            recommended: true,
            url: 'https://github.com/deanhiller/webpieces-ts/blob/main/claude.patterns.md#error-handling-pattern',
        },
        messages: {
            missingToError:
                'Catch block must call toError({{param}}) as first statement or comment it out to explicitly ignore errors',
            wrongVariableName: 'Error variable must be named "{{expected}}", got "{{actual}}"',
            missingTypeAnnotation: 'Catch parameter must be typed as "unknown": catch ({{param}}: unknown)',
            wrongParameterName:
                'Catch parameter must be named "err" (or "err2", "err3" for nested catches), got "{{actual}}"',
            toErrorNotFirst: 'toError({{param}}) must be the first statement in the catch block',
        },
        fixable: undefined,
        schema: [],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const catchStack: CatchClauseNode[] = [];

        return {
            CatchClause(node: any): void {
                const catchNode = node as CatchClauseNode;
                const depth = catchStack.length + 1;
                catchStack.push(catchNode);

                const suffix = depth === 1 ? '' : String(depth);
                const expectedParamName = 'err' + suffix;
                const expectedVarName = 'error' + suffix;

                const param = catchNode.param;
                if (!param) {
                    context.report({
                        node: catchNode,
                        messageId: 'missingTypeAnnotation',
                        data: { param: expectedParamName },
                    });
                    return;
                }

                const actualParamName =
                    param.type === 'Identifier' ? param.name : expectedParamName;

                validateParamName(context, param, expectedParamName);
                validateTypeAnnotation(context, param, expectedParamName);

                const sourceCode = context.sourceCode || context.getSourceCode();
                if (hasIgnoreComment(catchNode, sourceCode, expectedVarName, actualParamName)) {
                    return;
                }

                const body = catchNode.body.body;
                if (body.length === 0) {
                    reportMissingToError(context, catchNode.body, expectedParamName);
                    return;
                }

                validateToErrorCall(context, body[0], expectedParamName, expectedVarName, actualParamName);
            },

            'CatchClause:exit'(): void {
                catchStack.pop();
            },
        };
    },
};

export = rule;
