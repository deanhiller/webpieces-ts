import * as ts from 'typescript';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { SourceLocation } from './SourceLocation';

/** Everything that declares object FIELDS: a class, an interface, or an inline `{ ... }`. */
export type ObjectShape = ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeLiteralNode;

/**
 * The BASES an object shape `extends`, resolved to the shapes that declare their fields (#1055).
 *
 * Only `extends` counts — `implements` adds no fields to a class. A base is followed through its
 * import by the checker, so it may live in another file, in another package read as SOURCE through
 * tsconfig `paths`, or in a published `.d.ts`.
 *
 * A base that does not resolve to a class, an interface or an object type alias (a mixin call, an
 * import the compiler cannot find) is a BUILD FAILURE rather than an unmapped entry. The unmapped
 * guards find a bad FIELD by walking the rendered schema, and a base that contributes no fields
 * leaves them nothing to find — the document would silently close over a subset of the wire shape,
 * which is the defect this exists to end.
 */
export class ObjectShapeBases {
    constructor(private readonly checker: ts.TypeChecker) {}

    /** The shapes `shape` extends, in `extends` order. An inline `{ ... }` extends nothing. */
    of(shape: ObjectShape): ObjectShape[] {
        if (ts.isTypeLiteralNode(shape)) {
            return [];
        }
        return (shape.heritageClauses ?? [])
            .filter((clause: ts.HeritageClause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
            .flatMap((clause: ts.HeritageClause) => Array.from(clause.types))
            .map((base: ts.ExpressionWithTypeArguments) => this.shapeOf(base));
    }

    /** The declaration a name points at, through imports and aliases. */
    declarationOf(name: ts.Node): ts.Declaration | undefined {
        const symbol = this.checker.getSymbolAtLocation(name);
        const resolved =
            symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        return resolved?.declarations?.[0];
    }

    private shapeOf(base: ts.ExpressionWithTypeArguments): ObjectShape {
        const expression = base.expression;
        const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
        const declaration = this.declarationOf(name);
        if (
            declaration !== undefined &&
            (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))
        ) {
            return declaration;
        }
        if (
            declaration !== undefined &&
            ts.isTypeAliasDeclaration(declaration) &&
            ts.isTypeLiteralNode(declaration.type)
        ) {
            return declaration.type;
        }
        throw new ApiDocExtractionError(
            `cannot flatten the fields of '${base.getText()}': it does not resolve to a class, an interface or an object type alias`,
            SourceLocation.of(base),
            'Extend a class or interface the compiler can resolve — check the import and the tsconfig ' +
                '`paths` that map its package — or write the fields out on this type.',
        );
    }
}
