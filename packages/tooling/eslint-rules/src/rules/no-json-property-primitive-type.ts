/**
 * ESLint rule: no-json-property-primitive-type
 *
 * Bans @JsonProperty({ type: String }), @JsonProperty({ type: Number }),
 * and @JsonProperty({ type: Boolean }).
 *
 * These pass the TypeScript build but break production deserialization.
 * The typescript-json-serializer `type` option expects class constructors,
 * not JavaScript primitive constructors.
 *
 * Correct usage:
 *   @JsonProperty()                      - for primitive arrays (string[], number[], boolean[])
 *   @JsonProperty({ type: MyDtoClass })  - for class types only
 */

import type { Rule } from 'eslint';

// webpieces-disable no-any-unknown -- ESTree AST node interfaces require any for dynamic properties
interface CallExpressionNode {
    type: 'CallExpression';
    // webpieces-disable no-any-unknown -- ESTree AST dynamic callee
    callee: { name?: string; [key: string]: any };
    // webpieces-disable no-any-unknown -- ESTree AST dynamic arguments array
    arguments: any[];
    // webpieces-disable no-any-unknown -- ESTree AST index signature
    [key: string]: any;
}

interface ObjectExpressionNode {
    type: 'ObjectExpression';
    properties: PropertyNode[];
}

interface PropertyNode {
    key?: { name?: string };
    value?: { type?: string; name?: string };
    // webpieces-disable no-any-unknown -- ESTree AST index signature
    [key: string]: any;
}

const BANNED_PRIMITIVES = ['String', 'Number', 'Boolean'];

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Ban @JsonProperty({ type: String/Number/Boolean }) — breaks production deserialization',
        },
        messages: {
            noPrimitiveType:
                '@JsonProperty({ type: {{ primitive }} }) breaks production deserialization. ' +
                'For primitive arrays (string[], number[], boolean[]), use @JsonProperty() with ' +
                'no type parameter. The type option is only for class types: ' +
                '@JsonProperty({ type: MyDtoClass }).',
        },
        schema: [],
    },
    create(context: Rule.RuleContext): Rule.RuleListener {
        return {
            CallExpression(node: CallExpressionNode): void {
                if (node.callee.name !== 'JsonProperty') return;
                const arg = node.arguments[0];
                if (!arg || arg.type !== 'ObjectExpression') return;
                const objArg = arg as ObjectExpressionNode;
                for (const prop of objArg.properties) {
                    if (
                        prop.key?.name === 'type' &&
                        prop.value?.type === 'Identifier' &&
                        BANNED_PRIMITIVES.includes(prop.value.name!)
                    ) {
                        context.report({
                            // webpieces-disable no-any-unknown -- ESTree AST cast for ESLint report
                            node: prop as unknown as Rule.Node,
                            messageId: 'noPrimitiveType',
                            data: { primitive: prop.value.name! },
                        });
                    }
                }
            },
        };
    },
};

export = rule;
