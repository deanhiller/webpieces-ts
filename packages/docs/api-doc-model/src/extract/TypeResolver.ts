import * as ts from 'typescript';
import { WpInt, WpMax, WpMin } from '@webpieces/core-util';
import {
    DocumentedField,
    DocumentedType,
    UnionDiscriminator,
    UnmappedType,
} from '../model/ApiDocModel';
import { PrimitiveKind, TypeRef } from '../model/TypeRef';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { JsDoc } from './JsDoc';
import { SourceLocation } from './SourceLocation';

/**
 * The decorators this resolver reads off a DTO property, named from the REAL SYMBOLS — a rename in
 * `core-util` is a compile error here rather than a literal that quietly stops matching. See
 * {@link ApiDocExtractor}'s constants for the full argument (issue #1001).
 */
const INT_DECORATOR = WpInt.name;
const MIN_DECORATOR = WpMin.name;
const MAX_DECORATOR = WpMax.name;

/**
 * The type-alias name that DECLARES integer-ness.
 *
 * This one is a LITERAL and cannot be anything else: `Integer` is a TYPE ALIAS, so there is no
 * runtime symbol whose `.name` could be read — `.name` is a property of a function, and a type has
 * erased by then. It is the one name in this package that a rename in `core-util` would not break at
 * compile time; the cure if that ever bites is to make integer-ness a decorator here too, not to
 * pretend a type has a runtime identity. See {@link ApiDocExtractor}'s constants for the argument
 * everywhere else (issue #1001).
 */
const INTEGER_ALIAS = 'Integer';

/**
 * Resolve declared TypeScript types into {@link TypeRef}s, registering every NAMED type it meets as
 * a {@link DocumentedType} a renderer can `$ref`.
 *
 * ## It walks TYPE NODES, not checker types, and that is load-bearing
 *
 * `type Integer = number` resolves, in the checker, to `number` — the alias is gone. Integer-ness is
 * therefore invisible to a checker-driven walk, and the whole reason `Integer` is the PREFERRED
 * spelling is that it COMPOSES: `Integer[]` and `Record<string, Integer>` say exactly which thing is
 * an integer, where a decorator on `counts?: number[]` cannot (the same ambiguity the deleted
 * `arrayItems` argument had). Walking the written syntax is what keeps that composition readable.
 *
 * ## Cycles terminate BY CONSTRUCTION
 *
 * Every named type is ONE entry in the model, registered before its fields are walked, so a type
 * that refers back to itself resolves to a `$ref` at the second visit and stops. There is NO depth
 * counter anywhere — a deep-but-finite graph of 7, 20 or 200 named hops is fully expanded, because
 * truncating one would silently publish an incomplete document. The ONLY thing that is cut is a
 * self-referential ANONYMOUS type, and it is cut by NODE IDENTITY (it has no name to `$ref`), with an
 * {@link UnmappedType} recorded so #982's guard has something to name.
 */
export class TypeResolver {
    private readonly types = new Map<string, DocumentedType>();
    private readonly unmapped: UnmappedType[] = [];
    /** Named types already registered (or mid-registration) — the cycle stop for the NAMED case. */
    private readonly registered = new Set<string>();
    /** Anonymous type literals currently being expanded — the cycle stop for the ANONYMOUS case. */
    private readonly expandingAnonymous = new Set<ts.TypeNode>();

    constructor(private readonly checker: ts.TypeChecker) {}

    /** Every named type reached so far, by name. */
    collectedTypes(): ReadonlyMap<string, DocumentedType> {
        return this.types;
    }

    /** Everything that could not be represented — recorded, never dropped. */
    collectedUnmapped(): readonly UnmappedType[] {
        return this.unmapped;
    }

    /** Resolve one written type, registering whatever named types it reaches. */
    resolve(node: ts.TypeNode, ownerName: string): TypeRef {
        if (ts.isParenthesizedTypeNode(node)) {
            return this.resolve(node.type, ownerName);
        }
        if (ts.isArrayTypeNode(node)) {
            return TypeRef.array(this.resolve(node.elementType, ownerName));
        }
        if (ts.isUnionTypeNode(node)) {
            return this.resolveUnion(node, ownerName);
        }
        if (ts.isTypeLiteralNode(node)) {
            return this.resolveAnonymousObject(node, ownerName);
        }
        if (ts.isLiteralTypeNode(node)) {
            return this.resolveLiteral(node);
        }
        if (ts.isTypeReferenceNode(node)) {
            return this.resolveReference(node, ownerName);
        }
        const primitive = TypeResolver.keywordOf(node.kind);
        if (primitive !== undefined) {
            return TypeRef.primitiveOf(primitive);
        }
        return this.recordUnmapped(node, 'no model representation for this type form');
    }

    /** `string` / `number` / `boolean` / `null` / `unknown`, or undefined for anything else. */
    // webpieces-disable no-function-outside-class -- private static lookup table of this class
    private static keywordOf(kind: ts.SyntaxKind): PrimitiveKind | undefined {
        switch (kind) {
            case ts.SyntaxKind.StringKeyword:
                return 'string';
            case ts.SyntaxKind.NumberKeyword:
                return 'number';
            case ts.SyntaxKind.BooleanKeyword:
                return 'boolean';
            case ts.SyntaxKind.NullKeyword:
                return 'null';
            case ts.SyntaxKind.UnknownKeyword:
            case ts.SyntaxKind.AnyKeyword:
            case ts.SyntaxKind.VoidKeyword:
                return 'unknown';
            default:
                return undefined;
        }
    }

    private resolveLiteral(node: ts.LiteralTypeNode): TypeRef {
        if (ts.isStringLiteral(node.literal)) {
            return TypeRef.enumOf([node.literal.text]);
        }
        if (node.literal.kind === ts.SyntaxKind.NullKeyword) {
            return TypeRef.primitiveOf('null');
        }
        if (
            node.literal.kind === ts.SyntaxKind.TrueKeyword ||
            node.literal.kind === ts.SyntaxKind.FalseKeyword
        ) {
            return TypeRef.primitiveOf('boolean');
        }
        if (ts.isNumericLiteral(node.literal)) {
            return TypeRef.primitiveOf('number');
        }
        return this.recordUnmapped(
            node,
            'literal type is neither a string, a number nor a boolean',
        );
    }

    /**
     * A union, after `null` / `undefined` have been dropped (the FIELD records those as nullable /
     * optional — see {@link fieldOf} — because `{}` and `{x: null}` are different wire documents).
     *
     * Three outcomes, in this order:
     *  - every branch a string literal  -> an ENUM
     *  - one branch left                -> that branch
     *  - every branch a named object    -> a UNION, with a DERIVED discriminator when every branch
     *                                      carries the same property typed as ONE string literal
     *  - anything else                  -> an {@link UnmappedType}. No invented discriminator, ever:
     *                                      a union TypeScript itself cannot narrow is not one a
     *                                      renderer may claim to.
     */
    private resolveUnion(node: ts.UnionTypeNode, ownerName: string): TypeRef {
        const branches = node.types.filter((t: ts.TypeNode) => !TypeResolver.isNullish(t));

        const literals = branches.filter(
            (t: ts.TypeNode) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal),
        );
        if (literals.length === branches.length && branches.length > 0) {
            return TypeRef.enumOf(
                literals.map(
                    (t: ts.TypeNode) =>
                        ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text,
                ),
            );
        }

        if (branches.length === 1) {
            return this.resolve(branches[0], ownerName);
        }
        if (branches.length === 0) {
            return TypeRef.primitiveOf('null');
        }

        const refs: TypeRef[] = branches.map((t: ts.TypeNode) => this.resolve(t, ownerName));
        if (!refs.every((r: TypeRef) => r.kind === 'ref')) {
            return this.recordUnmapped(
                node,
                'a union whose branches are not all NAMED object types has no discriminator a renderer could narrow on',
            );
        }

        const names = refs.map((r: TypeRef) => r.refName!);
        const discriminator = this.deriveDiscriminator(names);
        if (discriminator === undefined) {
            return this.recordUnmapped(
                node,
                'no property is typed as a single string literal on EVERY branch, so this union has no derivable discriminator',
            );
        }
        this.registerUnionAlias(node, names, discriminator);
        return TypeRef.union(names);
    }

    /** `null` and `undefined` branches — recorded as nullable/optional on the FIELD, not in the union. */
    // webpieces-disable no-function-outside-class -- private static predicate of this class
    private static isNullish(node: ts.TypeNode): boolean {
        if (
            node.kind === ts.SyntaxKind.UndefinedKeyword ||
            node.kind === ts.SyntaxKind.NullKeyword
        ) {
            return true;
        }
        return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
    }

    /**
     * The DERIVED discriminator: the property every branch declares as exactly ONE string literal,
     * with a value no two branches share. Derived, never invented — if the source does not narrow,
     * neither does the document.
     */
    private deriveDiscriminator(branchNames: readonly string[]): UnionDiscriminator | undefined {
        const branches = branchNames.map((name: string) => this.types.get(name));
        if (branches.some((b: DocumentedType | undefined) => b === undefined)) {
            return undefined;
        }
        const first = branches[0]!;
        for (const field of first.fields) {
            const values = new Map<string, string>();
            for (let i = 0; i < branches.length; i++) {
                const candidate = branches[i]!.fields.find(
                    (f: DocumentedField) => f.name === field.name,
                );
                const literal =
                    candidate !== undefined &&
                    candidate.type.kind === 'enum' &&
                    candidate.type.enumValues.length === 1
                        ? candidate.type.enumValues[0]
                        : undefined;
                if (literal === undefined) {
                    values.clear();
                    break;
                }
                values.set(branchNames[i], literal);
            }
            if (values.size === branches.length && new Set(values.values()).size === values.size) {
                return new UnionDiscriminator(field.name, values);
            }
        }
        return undefined;
    }

    /** A union written as a named `type X = A | B` becomes its own model entry, so #982 can `$ref` it. */
    private registerUnionAlias(
        node: ts.UnionTypeNode,
        branchNames: readonly string[],
        discriminator: UnionDiscriminator,
    ): void {
        const alias = node.parent;
        if (!ts.isTypeAliasDeclaration(alias)) {
            return;
        }
        const name = alias.name.text;
        if (this.registered.has(name)) {
            return;
        }
        this.registered.add(name);
        this.types.set(
            name,
            new DocumentedType(
                name,
                JsDoc.read(alias).description,
                [],
                [],
                branchNames,
                discriminator,
                undefined,
            ),
        );
    }

    /**
     * `Integer`, `Array<T>`, `Record<string, V>`, `Promise<T>`, and everything named — an interface,
     * a class, or a type alias. Anything else (a `Map`, a `Date`, a generic parameter) is recorded
     * rather than guessed at.
     */
    private resolveReference(node: ts.TypeReferenceNode, ownerName: string): TypeRef {
        const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
        const args = node.typeArguments ?? [];

        if (name === INTEGER_ALIAS) {
            return TypeRef.primitiveOf('number', /*integer*/ true);
        }
        if ((name === 'Array' || name === 'ReadonlyArray') && args.length === 1) {
            return TypeRef.array(this.resolve(args[0], ownerName));
        }
        if ((name === 'Record' || name === 'Partial') && args.length === 2) {
            return TypeRef.openMap(this.resolve(args[1], ownerName));
        }
        if (name === 'Promise' && args.length === 1) {
            return this.resolve(args[0], ownerName);
        }

        const declaration = this.declarationOf(node.typeName);
        if (declaration === undefined) {
            return this.recordUnmapped(node, `no declaration found for '${name}'`);
        }
        return this.resolveDeclaration(name, declaration, ownerName);
    }

    /**
     * Resolve a type by its DECLARATION rather than by a reference to it.
     *
     * The reference path above is the normal one — a field says `Customer` and the resolver follows
     * it. This entry point exists for a type that is named from OUTSIDE the source: a manifest naming
     * the document-wide error body, which no field in the contract points at. Same registration, same
     * cycle story, so the two cannot disagree about what a type IS.
     */
    resolveDeclaration(name: string, declaration: ts.Declaration, ownerName: string): TypeRef {
        if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
            return this.registerNamedObject(name, declaration);
        }
        if (ts.isTypeAliasDeclaration(declaration)) {
            return this.resolveAlias(name, declaration, ownerName);
        }
        if (ts.isEnumDeclaration(declaration)) {
            return this.registerStringEnum(name, declaration);
        }
        return this.recordUnmapped(
            declaration,
            `'${name}' is declared as something with no document shape`,
        );
    }

    /** `type X = ...` — registered under X when it has a shape of its own, else transparent. */
    private resolveAlias(name: string, alias: ts.TypeAliasDeclaration, ownerName: string): TypeRef {
        if (this.registered.has(name)) {
            return this.types.get(name)?.unionRefNames.length
                ? TypeRef.union(this.types.get(name)!.unionRefNames)
                : TypeRef.ref(name);
        }

        if (ts.isUnionTypeNode(alias.type)) {
            const resolved = this.resolve(alias.type, ownerName);
            if (resolved.kind === 'enum') {
                this.registered.add(name);
                this.types.set(
                    name,
                    new DocumentedType(
                        name,
                        JsDoc.read(alias).description,
                        [],
                        resolved.enumValues,
                        [],
                        undefined,
                        undefined,
                    ),
                );
                return TypeRef.ref(name);
            }
            return resolved;
        }

        if (ts.isTypeLiteralNode(alias.type)) {
            return this.registerNamedObject(name, alias.type, alias);
        }
        return this.resolve(alias.type, ownerName);
    }

    /** A TS `enum` of string members — the one non-union enum shape a document can carry. */
    private registerStringEnum(name: string, declaration: ts.EnumDeclaration): TypeRef {
        if (this.registered.has(name)) {
            return TypeRef.ref(name);
        }
        const values: string[] = [];
        for (const member of declaration.members) {
            if (member.initializer && ts.isStringLiteral(member.initializer)) {
                values.push(member.initializer.text);
            }
        }
        if (values.length !== declaration.members.length) {
            return this.recordUnmapped(
                declaration,
                `enum '${name}' has members that are not string literals`,
            );
        }
        this.registered.add(name);
        this.types.set(
            name,
            new DocumentedType(
                name,
                JsDoc.read(declaration).description,
                [],
                values,
                [],
                undefined,
                undefined,
            ),
        );
        return TypeRef.ref(name);
    }

    /**
     * Register a named object shape, RESERVING THE NAME BEFORE walking its fields. That order is the
     * whole cycle story: a type that refers back to itself meets `registered.has(name)` on the second
     * visit and resolves to a `$ref`, so the walk terminates with no counter and no truncation.
     */
    private registerNamedObject(
        name: string,
        shape: ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeLiteralNode,
        docSource?: ts.Node,
    ): TypeRef {
        if (this.registered.has(name)) {
            return TypeRef.ref(name);
        }
        this.registered.add(name);

        const fields: DocumentedField[] = [];
        let indexSignature: TypeRef | undefined;
        for (const member of shape.members) {
            if (ts.isIndexSignatureDeclaration(member)) {
                indexSignature = this.resolve(member.type, name);
                continue;
            }
            const field = this.fieldOf(member, name);
            if (field !== undefined) {
                fields.push(field);
            }
        }

        this.types.set(
            name,
            new DocumentedType(
                name,
                JsDoc.read(docSource ?? shape).description,
                fields,
                [],
                [],
                undefined,
                indexSignature,
            ),
        );
        return TypeRef.ref(name);
    }

    /**
     * An inline `{ ... }`. It has no name to `$ref`, so it is registered under an OWNER-DERIVED one
     * (`Parent.field`) — a renderer needs a target, and a name derived from where the shape is
     * written is the only honest one available.
     *
     * A self-referential anonymous type is cut HERE, by NODE IDENTITY. It cannot be a `$ref` (there
     * is no declared name to point at) and it cannot be expanded (it would never end), so it is
     * recorded as unmapped and the walk returns.
     */
    private resolveAnonymousObject(node: ts.TypeLiteralNode, ownerName: string): TypeRef {
        if (this.expandingAnonymous.has(node)) {
            return this.recordUnmapped(
                node,
                'a self-referential ANONYMOUS object type has no name a renderer could $ref; give it a name',
            );
        }
        const indexOnly =
            node.members.length === 1 && ts.isIndexSignatureDeclaration(node.members[0]);
        if (indexOnly) {
            const signature = node.members[0] as ts.IndexSignatureDeclaration;
            return TypeRef.openMap(this.resolve(signature.type, ownerName));
        }

        this.expandingAnonymous.add(node);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the stack entry must be dropped whatever the walk does
        try {
            return this.registerNamedObject(ownerName, node);
        } finally {
            this.expandingAnonymous.delete(node);
        }
    }

    /** ONE property of a DTO — its type, its optionality, its prose and its numeric constraints. */
    private fieldOf(
        member: ts.TypeElement | ts.ClassElement,
        ownerName: string,
    ): DocumentedField | undefined {
        if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) {
            return undefined;
        }
        if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
            return undefined;
        }
        const name = member.name.text;
        if (member.type === undefined) {
            return undefined;
        }

        const optional =
            member.questionToken !== undefined || TypeResolver.declaresUndefined(member.type);
        const nullable = TypeResolver.declaresNull(member.type);

        let type = this.resolve(member.type, `${ownerName}.${name}`);
        if (TypeResolver.hasDecorator(member, INT_DECORATOR)) {
            type = TypeResolver.markInteger(type);
        }

        const doc = JsDoc.read(member);
        const min = this.numericArgument(member, MIN_DECORATOR);
        const max = this.numericArgument(member, MAX_DECORATOR);
        this.assertNumericConstraintsFit(member, name, type, min, max);

        return new DocumentedField(
            name,
            type,
            optional,
            nullable,
            doc.description,
            doc.mcp,
            doc.format,
            min,
            max,
            doc.mcpHeader,
        );
    }

    /**
     * `@WpMin` / `@WpMax` on a non-numeric field is a BUILD FAILURE, not a warning. A minimum on a
     * string is not something a renderer can emit sensibly, and a document that silently dropped it
     * would publish a contract weaker than the one its author wrote down.
     */
    private assertNumericConstraintsFit(
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
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static markInteger(type: TypeRef): TypeRef {
        if (type.kind === 'array') {
            return TypeRef.array(type.items!.asInteger());
        }
        if (type.kind === 'openMap') {
            return TypeRef.openMap(type.values!.asInteger());
        }
        return type.asInteger();
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static declaresUndefined(node: ts.TypeNode): boolean {
        return (
            ts.isUnionTypeNode(node) &&
            node.types.some((t: ts.TypeNode) => t.kind === ts.SyntaxKind.UndefinedKeyword)
        );
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static declaresNull(node: ts.TypeNode): boolean {
        return (
            ts.isUnionTypeNode(node) &&
            node.types.some(
                (t: ts.TypeNode) =>
                    t.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
            )
        );
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static hasDecorator(node: ts.Node, decoratorName: string): boolean {
        return TypeResolver.decoratorCall(node, decoratorName) !== undefined;
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static decoratorCall(
        node: ts.Node,
        decoratorName: string,
    ): ts.CallExpression | undefined {
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

    private numericArgument(node: ts.Node, decoratorName: string): number | undefined {
        const call = TypeResolver.decoratorCall(node, decoratorName);
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

    /** The declaration a type name points at, through imports and aliases. */
    private declarationOf(name: ts.EntityName): ts.Declaration | undefined {
        const symbol = this.checker.getSymbolAtLocation(name);
        const resolved =
            symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        return resolved?.declarations?.[0];
    }

    private recordUnmapped(node: ts.Node, reason: string): TypeRef {
        const text = node.getText();
        this.unmapped.push(new UnmappedType(text, SourceLocation.of(node), reason));
        return TypeRef.unmapped(text);
    }
}
