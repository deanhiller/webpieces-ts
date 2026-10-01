import * as ts from 'typescript';
import { WpInt, WpMax, WpMin } from '@webpieces/core-util';
import {
    DocumentedField,
    DocumentedType,
    TypeNameCollision,
    UnionDiscriminator,
    UnmappedType,
} from '../model/ApiDocModel';
import { PrimitiveKind, TypeRef } from '../model/TypeRef';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { JsDoc } from './JsDoc';
import { ObjectShape, ObjectShapeBases } from './ObjectShapeBases';
import { FieldDecorators } from './FieldDecorators';
import { PackageOfFile } from './PackageOfFile';
import { TypeRegistry } from './TypeRegistry';
import { SourceLocation } from './SourceLocation';
import { StringValueSets } from './StringValueSets';

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
 *
 * ## Every type is keyed by its DECLARING PACKAGE too (#1058)
 *
 * A type is registered under {@link DocumentedType.keyOf}: its bare name when the HOME package (the
 * one whose file is being extracted) declares it, `<package>:<name>` otherwise. Two packages'
 * same-named types are therefore two entries rather than one silently standing in for the other, and
 * a renderer can tell which document owns each schema. The name is always the DECLARATION's own, never
 * an import alias, so one type reached under two spellings is still one entry.
 */
export class TypeResolver {
    private readonly unmapped: UnmappedType[] = [];
    /** Every named type, its key and the declaration that claimed it — see {@link TypeRegistry}. */
    private readonly registry: TypeRegistry;
    /** Anonymous type literals currently being expanded — the cycle stop for the ANONYMOUS case. */
    private readonly expandingAnonymous = new Set<ts.TypeNode>();

    private readonly bases: ObjectShapeBases;

    constructor(
        checker: ts.TypeChecker,
        packages: PackageOfFile,
        /** The package of the file being extracted — its types are keyed by their bare name. */
        homePackage: string | undefined,
    ) {
        this.bases = new ObjectShapeBases(checker);
        this.registry = new TypeRegistry(packages, homePackage);
    }

    /** Every named type reached so far, by key — see {@link DocumentedType.keyOf}. */
    collectedTypes(): ReadonlyMap<string, DocumentedType> {
        return this.registry.types;
    }

    /** Everything that could not be represented — recorded, never dropped. */
    collectedUnmapped(): readonly UnmappedType[] {
        return this.unmapped;
    }

    /** Same-named, different declarations in one package — see {@link TypeNameCollision}. */
    collectedCollisions(): readonly TypeNameCollision[] {
        return this.registry.collisions;
    }

    /** The key `name`, declared at `node`, is registered under. */
    keyFor(name: string, node: ts.Node): string {
        return this.registry.keyFor(name, node);
    }

    /** Resolve one written type, registering whatever named types it reaches. */
    resolve(node: ts.TypeNode, ownerName: string): TypeRef {
        if (ts.isParenthesizedTypeNode(node)) {
            return this.resolve(node.type, ownerName);
        }
        if (ts.isArrayTypeNode(node)) {
            return TypeRef.array(this.resolve(node.elementType, ownerName));
        }
        // `readonly X[]` is a TypeOperator wrapping the array. `readonly` is a compile-time promise
        // about the HOLDER, not the wire: the JSON is the same array, so it resolves exactly like
        // `X[]` — as `ReadonlyArray<X>` already does in resolveReference (#1055).
        if (
            ts.isTypeOperatorNode(node) &&
            node.operator === ts.SyntaxKind.ReadonlyKeyword &&
            ts.isArrayTypeNode(node.type)
        ) {
            return this.resolve(node.type, ownerName);
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
     * The outcomes, in this order:
     *  - every branch a string literal  -> an ENUM
     *  - one branch left                -> that branch
     *  - every branch a string VALUE    -> an ENUM of all of them: string literals, string-enum
     *    (literal, enum member, or        members (`VoiceMode.A | VoiceMode.B`) and whole string
     *    whole string enum)               enums, in declaration order (#1023)
     *  - every branch a named object    -> a UNION, with a DERIVED discriminator when every branch
     *                                      carries the same property typed as string VALUES — one
     *                                      literal / enum member, or a union of them — and no value
     *                                      is claimed by two branches
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
        const values = new StringValueSets(this.registry.types).valuesOfAll(refs);
        if (values !== undefined) {
            return TypeRef.enumOf(values);
        }
        if (!refs.every((r: TypeRef) => r.kind === 'ref')) {
            return this.recordUnmapped(
                node,
                'a union whose branches are not all NAMED object types has no discriminator a renderer could narrow on',
            );
        }

        const names = refs.map((r: TypeRef) => r.refName!);
        const discriminator = new StringValueSets(this.registry.types).derive(names);
        if (discriminator === undefined) {
            return this.recordUnmapped(
                node,
                'no property is typed as string values (a literal, a string-enum member, or a union of them) on EVERY ' +
                    'branch with no value shared by two branches, so this union has no derivable discriminator',
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
        const key = this.registry.keyFor(name, alias);
        if (this.registry.alreadyRegistered(key, name, alias)) {
            return;
        }
        this.registry.registered.add(key);
        this.registry.types.set(
            key,
            this.registry.documented(
                name,
                alias,
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

        // `VoiceMode.RANDOM` is a QualifiedName; the member's symbol is the one on its RIGHT side.
        const declaration = this.declarationOf(
            ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName,
        );
        if (declaration === undefined) {
            return this.recordUnmapped(node, `no declaration found for '${name}'`);
        }
        return this.resolveDeclaration(
            TypeResolver.declaredName(declaration, name),
            declaration,
            ownerName,
        );
    }

    /**
     * The DECLARATION's own name, not the spelling at the use site: `import { Foo as Bar }` still
     * reaches the type `Foo`, which is what its owning package's document calls it (#1058).
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static declaredName(declaration: ts.Declaration, written: string): string {
        const named =
            ts.isInterfaceDeclaration(declaration) ||
            ts.isClassDeclaration(declaration) ||
            ts.isTypeAliasDeclaration(declaration) ||
            ts.isEnumDeclaration(declaration);
        return named && declaration.name !== undefined ? declaration.name.text : written;
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
        if (ts.isEnumMember(declaration)) {
            return this.resolveEnumMember(name, declaration);
        }
        return this.recordUnmapped(
            declaration,
            `'${name}' is declared as something with no document shape`,
        );
    }

    /** `type X = ...` — registered under X when it has a shape of its own, else transparent. */
    private resolveAlias(name: string, alias: ts.TypeAliasDeclaration, ownerName: string): TypeRef {
        const key = this.registry.keyFor(name, alias);
        if (this.registry.alreadyRegistered(key, name, alias)) {
            return this.registry.types.get(key)?.unionRefNames.length
                ? TypeRef.union(this.registry.types.get(key)!.unionRefNames)
                : TypeRef.ref(key);
        }

        if (ts.isUnionTypeNode(alias.type)) {
            const resolved = this.resolve(alias.type, ownerName);
            if (resolved.kind === 'enum') {
                this.registry.registered.add(key);
                this.registry.types.set(
                    key,
                    this.registry.documented(
                        name,
                        alias,
                        JsDoc.read(alias).description,
                        [],
                        resolved.enumValues,
                        [],
                        undefined,
                        undefined,
                    ),
                );
                return TypeRef.ref(key);
            }
            return resolved;
        }

        if (ts.isTypeLiteralNode(alias.type)) {
            return this.registerNamedObject(name, alias.type, alias);
        }
        return this.resolve(alias.type, ownerName);
    }

    /**
     * ONE member of a string enum used as a type — `mode: VoiceMode.RANDOM` — which holds exactly
     * that member's VALUE on the wire. It is what a union branch's discriminator is written as once
     * the enum is the one spelling of a fixed set (#1023), so it resolves to a one-value enum exactly
     * like `mode: 'random'` does.
     */
    private resolveEnumMember(name: string, member: ts.EnumMember): TypeRef {
        if (member.initializer !== undefined && ts.isStringLiteral(member.initializer)) {
            return TypeRef.enumOf([member.initializer.text]);
        }
        return this.recordUnmapped(
            member,
            `enum member '${name}' is not initialised with a string literal, so it has no string value to publish`,
        );
    }

    /** A TS `enum` of string members — the one non-union enum shape a document can carry. */
    private registerStringEnum(name: string, declaration: ts.EnumDeclaration): TypeRef {
        const key = this.registry.keyFor(name, declaration);
        if (this.registry.alreadyRegistered(key, name, declaration)) {
            return TypeRef.ref(key);
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
        this.registry.registered.add(key);
        this.registry.types.set(
            key,
            this.registry.documented(
                name,
                declaration,
                JsDoc.read(declaration).description,
                [],
                values,
                [],
                undefined,
                undefined,
            ),
        );
        return TypeRef.ref(key);
    }

    /**
     * Register a named object shape, RESERVING THE NAME BEFORE walking its fields. That order is the
     * whole cycle story: a type that refers back to itself meets `registered.has(name)` on the second
     * visit and resolves to a `$ref`, so the walk terminates with no counter and no truncation.
     *
     * The fields are the shape's WHOLE document — every field it inherits through `extends` as well
     * as its own. See {@link collectFields}.
     */
    private registerNamedObject(name: string, shape: ObjectShape, docSource?: ts.Node): TypeRef {
        const declaration = docSource ?? shape;
        const key = this.registry.keyFor(name, declaration);
        if (this.registry.registered.has(key)) {
            // An ANONYMOUS `{ ... }` is named after where it is written, so two of them can share an
            // owner-derived name; that was never a declared-name collision and is not recorded as one.
            if (!ts.isTypeLiteralNode(declaration)) {
                this.registry.alreadyRegistered(key, name, declaration);
            }
            return TypeRef.ref(key);
        }
        this.registry.claimedBy.set(key, declaration);
        this.registry.registered.add(key);

        const fields = new Map<string, DocumentedField>();
        const indexSignature = this.collectFields(shape, name, fields, new Set<ObjectShape>());

        this.registry.types.set(
            key,
            this.registry.documented(
                name,
                declaration,
                JsDoc.read(declaration).description,
                Array.from(fields.values()),
                [],
                [],
                undefined,
                indexSignature,
            ),
        );
        return TypeRef.ref(key);
    }

    /**
     * Collect `shape`'s fields into `fields`, FLATTENING every base it `extends` (#1055).
     *
     * A subclass's JSON carries its base's fields, so a document that published only the subclass's
     * own members was a CLOSED schema (`additionalProperties: false`) that refused every real call.
     * The rules are TypeScript's own:
     *
     * - bases first, in `extends` order (`interface X extends A, B`), each walked recursively, so a
     *   two-level chain flattens completely;
     * - a redeclared field WINS — `Map.set` replaces the inherited entry in its original position —
     *   and it is the redeclaration's type, optionality, prose and bounds that publish, because
     *   required/optional belongs to whichever type DECLARES the field;
     * - a base may live in another file or package (source or a published `.d.ts`); its JSDoc is
     *   read from there.
     *
     * Flattened, not `allOf: [{$ref: Base}, {...}]`: an MCP client reads `properties` + `required`
     * directly, and a base is an implementation detail of the TypeScript, not a wire concept. So a
     * base is NOT registered as a model entry of its own; it appears only if something refers to it.
     *
     * Which bases count, and why an unresolvable one is a build failure, is {@link ObjectShapeBases}.
     */
    private collectFields(
        shape: ObjectShape,
        ownerName: string,
        fields: Map<string, DocumentedField>,
        visiting: Set<ObjectShape>,
    ): TypeRef | undefined {
        visiting.add(shape);
        let indexSignature: TypeRef | undefined;
        for (const baseShape of this.bases.of(shape)) {
            if (visiting.has(baseShape)) {
                continue;
            }
            indexSignature =
                this.collectFields(baseShape, ownerName, fields, visiting) ?? indexSignature;
        }
        for (const member of shape.members) {
            if (ts.isIndexSignatureDeclaration(member)) {
                indexSignature = this.resolve(member.type, ownerName);
                continue;
            }
            const field = this.fieldOf(member, ownerName);
            if (field !== undefined) {
                fields.set(field.name, field);
            }
        }
        visiting.delete(shape);
        return indexSignature;
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
            member.questionToken !== undefined || FieldDecorators.declaresUndefined(member.type);
        const nullable = FieldDecorators.declaresNull(member.type);

        let type = this.resolve(member.type, `${ownerName}.${name}`);
        if (FieldDecorators.hasDecorator(member, INT_DECORATOR)) {
            type = FieldDecorators.markInteger(type);
        }

        const doc = JsDoc.read(member);
        const min = FieldDecorators.numericArgument(member, MIN_DECORATOR);
        const max = FieldDecorators.numericArgument(member, MAX_DECORATOR);
        FieldDecorators.assertNumericConstraintsFit(member, name, type, min, max);

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
            SourceLocation.of(member),
        );
    }

    /** The declaration a type name points at, through imports and aliases. */
    private declarationOf(name: ts.EntityName): ts.Declaration | undefined {
        return this.bases.declarationOf(name);
    }

    private recordUnmapped(node: ts.Node, reason: string): TypeRef {
        const text = node.getText();
        this.unmapped.push(new UnmappedType(text, SourceLocation.of(node), reason));
        return TypeRef.unmapped(text);
    }
}
