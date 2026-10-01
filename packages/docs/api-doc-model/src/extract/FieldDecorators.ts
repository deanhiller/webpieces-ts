import * as ts from 'typescript';
import { WpMax, WpMin } from '@webpieces/core-util';
import { TypeRef } from '../model/TypeRef';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { SourceLocation } from './SourceLocation';

/** Named from the REAL SYMBOLS, so a rename in `core-util` fails to compile here (issue #1001). */
const MIN_DECORATOR = WpMin.name;
const MAX_DECORATOR = WpMax.name;

/**
 * What a DTO PROPERTY's decorators and declared type say beyond its type: `@WpInt()`, `@WpMin` /
 * `@WpMax`, and whether the declaration admits `undefined` or `null`. Read by {@link TypeResolver}
 * for every field it resolves; split out of it so each file stays one concern.
 */
export class FieldDecorators {
    /**
     * `@WpMin` / `@WpMax` on a non-numeric field is a BUILD FAILURE, not a warning. A minimum on a
     * string is not something a renderer can emit sensibly, and a document that silently dropped it
     * would publish a contract weaker than the one its author wrote down.
     */
    // webpieces-disable no-function-outside-class -- static helper of this class
    static assertNumericConstraintsFit(
        member: ts.Node,
        name: string,
        type: TypeRef,
        min: number | undefined,
        max: number | undefined,
    ): void {
        if (min === undefined && max === undefined) {
            return;
        }
        const numeric = type.isNumeric() || (type.kind === 'array' && type.items!.isNumeric());
        if (numeric) {
            return;
        }
        throw new ApiDocExtractionError(
            `@${MIN_DECORATOR}/@${MAX_DECORATOR} on non-numeric field '${name}'`,
            SourceLocation.of(member),
            'Put the constraint on a `number` / `Integer` field, or drop it.',
        );
    }

    /** `@WpInt()` decorates the FIELD, so the integer flag is pushed onto the right leaf. */
    // webpieces-disable no-function-outside-class -- static helper of this class
    static markInteger(type: TypeRef): TypeRef {
        if (type.kind === 'array') {
            return TypeRef.array(type.items!.asInteger());
        }
        if (type.kind === 'openMap') {
            return TypeRef.openMap(type.values!.asInteger());
        }
        return type.asInteger();
    }

    // webpieces-disable no-function-outside-class -- static helper of this class
    static declaresUndefined(node: ts.TypeNode): boolean {
        return (
            ts.isUnionTypeNode(node) &&
            node.types.some((t: ts.TypeNode) => t.kind === ts.SyntaxKind.UndefinedKeyword)
        );
    }

    // webpieces-disable no-function-outside-class -- static helper of this class
    static declaresNull(node: ts.TypeNode): boolean {
        return (
            ts.isUnionTypeNode(node) &&
            node.types.some(
                (t: ts.TypeNode) =>
                    t.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
            )
        );
    }

    // webpieces-disable no-function-outside-class -- static helper of this class
    static hasDecorator(node: ts.Node, decoratorName: string): boolean {
        return FieldDecorators.decoratorCall(node, decoratorName) !== undefined;
    }

    // webpieces-disable no-function-outside-class -- static helper of this class
    static decoratorCall(node: ts.Node, decoratorName: string): ts.CallExpression | undefined {
        const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
        for (const decorator of decorators) {
            const call = decorator.expression;
            if (
                ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                call.expression.text === decoratorName
            ) {
                return call;
            }
        }
        return undefined;
    }

    // webpieces-disable no-function-outside-class -- static helper of this class
    static numericArgument(node: ts.Node, decoratorName: string): number | undefined {
        const call = FieldDecorators.decoratorCall(node, decoratorName);
        const argument = call?.arguments[0];
        if (argument === undefined) {
            return undefined;
        }
        if (ts.isNumericLiteral(argument)) {
            return Number(argument.text);
        }
        if (
            ts.isPrefixUnaryExpression(argument) &&
            argument.operator === ts.SyntaxKind.MinusToken &&
            ts.isNumericLiteral(argument.operand)
        ) {
            return -Number(argument.operand.text);
        }
        throw new ApiDocExtractionError(
            `@${decoratorName} argument is not a numeric literal: '${argument.getText()}'`,
            SourceLocation.of(argument),
            'Write the bound as a numeric literal. A value only known at runtime cannot be published.',
        );
    }
}
