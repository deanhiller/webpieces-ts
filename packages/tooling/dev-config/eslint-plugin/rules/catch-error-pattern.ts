/**
 * ESLint rule to enforce standardized catch block error handling patterns
 *
 * Enforces three approved patterns:
 * 1. Standard: catch (err: any) { const error = toError(err); }
 * 2. Ignored: catch (err: any) { //const error = toError(err); }
 * 3. Nested: catch (err2: any) { const error2 = toError(err2); }
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
            missingTypeAnnotation: 'Catch parameter must be typed as "any": catch ({{param}}: any)',
            wrongParameterName:
                'Catch parameter must be named "err" (or "err2", "err3" for nested catches), got "{{actual}}"',
            toErrorNotFirst: 'toError({{param}}) must be the first statement in the catch block',
        },
        fixable: undefined,
        schema: [],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        // Track nesting depth for err, err2, err3, etc.
        const catchStack: CatchClauseNode[] = [];

        return {
            CatchClause(node: any): void {
                const catchNode = node as CatchClauseNode;

                // Calculate depth (1-based: first catch is depth 1)
                const depth = catchStack.length + 1;
                catchStack.push(catchNode);

                // Build expected names based on depth
                const suffix = depth === 1 ? '' : String(depth);
                const expectedParamName = 'err' + suffix;
                const expectedVarName = 'error' + suffix;

                // Get the catch parameter
                const param = catchNode.param;
                if (!param) {
                    // No parameter - unusual but technically valid (though not our pattern)
                    context.report({
                        node: catchNode,
                        messageId: 'missingTypeAnnotation',
                        data: { param: expectedParamName },
                    });
                    return;
                }

                // Track the actual parameter name for validation (may differ from expected)
                const actualParamName =
                    param.type === 'Identifier' ? param.name : expectedParamName;

                // RULE 1: Parameter must be named correctly (err, err2, err3, etc.)
                if (param.type === 'Identifier' && param.name !== expectedParamName) {
                    context.report({
                        node: param,
                        messageId: 'wrongParameterName',
                        data: {
                            actual: param.name,
                        },
                    });
                }

                // RULE 2: Must have type annotation ": any"
                if (
                    !param.typeAnnotation ||
                    !param.typeAnnotation.typeAnnotation ||
                    param.typeAnnotation.typeAnnotation.type !== 'TSAnyKeyword'
                ) {
                    context.report({
                        node: param,
                        messageId: 'missingTypeAnnotation',
                        data: {
                            param: param.name || expectedParamName,
                        },
                    });
                }

                // RULE 3: Check first statement in catch block
                const body = catchNode.body.body;
                const sourceCode = context.sourceCode || context.getSourceCode();

                // IMPORTANT: Check for commented ignore pattern FIRST (before checking if body is empty)
                // This allows Pattern 2 (empty catch with only comment) to be valid
                // Look for: //const error = toError(err);
                const catchBlockStart = catchNode.body.range![0];
                const catchBlockEnd = catchNode.body.range![1];
                const catchBlockText = sourceCode.text.substring(catchBlockStart, catchBlockEnd);

                const ignorePattern = new RegExp(
                    `//\\s*const\\s+${expectedVarName}\\s*=\\s*toError\\(${actualParamName}\\)`,
                );

                if (ignorePattern.test(catchBlockText)) {
                    // Pattern 2: Explicitly ignored - valid!
                    return;
                }

                // Now check if body is empty (after checking for commented pattern)
                if (body.length === 0) {
                    // Empty catch block without comment - not allowed
                    context.report({
                        node: catchNode.body,
                        messageId: 'missingToError',
                        data: {
                            param: expectedParamName,
                        },
                    });
                    return;
                }

                const firstStatement = body[0];

                // Check if first statement is: const error = toError(err)
                if (firstStatement.type !== 'VariableDeclaration') {
                    context.report({
                        node: firstStatement,
                        messageId: 'missingToError',
                        data: {
                            param: expectedParamName,
                        },
                    });
                    return;
                }

                const varDecl = firstStatement as VariableDeclarationNode;
                const declaration = varDecl.declarations[0];
                if (!declaration) {
                    context.report({
                        node: firstStatement,
                        messageId: 'missingToError',
                        data: {
                            param: expectedParamName,
                        },
                    });
                    return;
                }

                // Check variable name
                if (
                    declaration.id.type !== 'Identifier' ||
                    declaration.id.name !== expectedVarName
                ) {
                    context.report({
                        node: declaration.id,
                        messageId: 'wrongVariableName',
                        data: {
                            expected: expectedVarName,
                            actual: declaration.id.name || 'unknown',
                        },
                    });
                    return;
                }

                // Check initialization: toError(err)
                if (!declaration.init) {
                    context.report({
                        node: declaration,
                        messageId: 'missingToError',
                        data: {
                            param: expectedParamName,
                        },
                    });
                    return;
                }

                if (declaration.init.type !== 'CallExpression') {
                    context.report({
                        node: declaration.init,
                        messageId: 'missingToError',
                        data: {
                            param: expectedParamName,
                        },
                    });
                    return;
                }

                const callExpr = declaration.init as CallExpressionNode;
                const callee = callExpr.callee;
                if (callee.type !== 'Identifier' || callee.name !== 'toError') {
                    context.report({
                        node: callee,
                        messageId: 'missingToError',
                        data: {
                            param: expectedParamName,
                        },
                    });
                    return;
                }

                // Check argument: must be the catch parameter (use actual param name)
                const args = callExpr.arguments;
                if (
                    args.length !== 1 ||
                    args[0].type !== 'Identifier' ||
                    (args[0] as IdentifierNode).name !== actualParamName
                ) {
                    context.report({
                        node: callExpr,
                        messageId: 'missingToError',
                        data: {
                            param: actualParamName,
                        },
                    });
                    return;
                }

                // All checks passed! ✅
            },

            'CatchClause:exit'(): void {
                catchStack.pop();
            },
        };
    },
};

export = rule;
