/**
 * How a single declared type was RESOLVED. This is the leaf of the model: every field, every request
 * and every response points at one of these.
 *
 * It is a CLASS with static factories rather than a discriminated union of interfaces, per
 * `CLAUDE.md` §1 — it is data, it is constructed explicitly, and a renderer pattern-matches on
 * `kind`. The factories exist because the combinations are not free-form: an `array` always has
 * `items`, an `openMap` always has `values`, a `ref` always has `refName`, and a constructor taking
 * eight optional fields would let a caller build a shape no resolver can produce.
 */
export type TypeRefKind = 'primitive' | 'ref' | 'array' | 'openMap' | 'enum' | 'union' | 'unmapped';

/** The scalar kinds a renderer can emit without any further lookup. */
export type PrimitiveKind = 'string' | 'number' | 'boolean' | 'null' | 'unknown';

export class TypeRef {
    private constructor(
        readonly kind: TypeRefKind,
        /** Set when `kind === 'primitive'`. */
        readonly primitive: PrimitiveKind | undefined,
        /** Set when `kind === 'ref'` — the name of a {@link DocumentedType} in the model. */
        readonly refName: string | undefined,
        /** Set when `kind === 'array'` — the ITEM type. */
        readonly items: TypeRef | undefined,
        /** Set when `kind === 'openMap'` — the VALUE type of an index signature. */
        readonly values: TypeRef | undefined,
        /** Set when `kind === 'enum'` — the string-literal members, in declaration order. */
        readonly enumValues: readonly string[],
        /** Set when `kind === 'union'` — the branch type names, in declaration order. */
        readonly unionRefNames: readonly string[],
        /**
         * INTEGER-ness, which TypeScript itself cannot express: it has one numeric type. Declared by
         * writing `Integer` (preferred — it composes: `Integer[]`, `Record<string, Integer>`) or by
         * putting `@WpInt()` on the field. Both produce this same flag; see `responsibilities.md`.
         */
        readonly integer: boolean,
        /** Set when `kind === 'unmapped'` — the verbatim TS type text, for a renderer's guard. */
        readonly unmappedText: string | undefined,
    ) {}

    // webpieces-disable no-function-outside-class -- static factories on the class itself; the private constructor is what stops an impossible combination being built
    static primitiveOf(primitive: PrimitiveKind, integer = false): TypeRef {
        return new TypeRef(
            'primitive',
            primitive,
            undefined,
            undefined,
            undefined,
            [],
            [],
            integer,
            undefined,
        );
    }

    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops an impossible combination being built
    static ref(refName: string): TypeRef {
        return new TypeRef(
            'ref',
            undefined,
            refName,
            undefined,
            undefined,
            [],
            [],
            false,
            undefined,
        );
    }

    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops an impossible combination being built
    static array(items: TypeRef): TypeRef {
        return new TypeRef(
            'array',
            undefined,
            undefined,
            items,
            undefined,
            [],
            [],
            false,
            undefined,
        );
    }

    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops an impossible combination being built
    static openMap(values: TypeRef): TypeRef {
        return new TypeRef(
            'openMap',
            undefined,
            undefined,
            undefined,
            values,
            [],
            [],
            false,
            undefined,
        );
    }

    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops an impossible combination being built
    static enumOf(enumValues: readonly string[]): TypeRef {
        return new TypeRef(
            'enum',
            undefined,
            undefined,
            undefined,
            undefined,
            enumValues,
            [],
            false,
            undefined,
        );
    }

    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops an impossible combination being built
    static union(unionRefNames: readonly string[]): TypeRef {
        return new TypeRef(
            'union',
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            unionRefNames,
            false,
            undefined,
        );
    }

    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops an impossible combination being built
    static unmapped(unmappedText: string): TypeRef {
        return new TypeRef(
            'unmapped',
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            [],
            false,
            unmappedText,
        );
    }

    /** The same ref, marked integer. Used by `@WpInt()`, which decorates the FIELD, not the type. */
    asInteger(): TypeRef {
        return new TypeRef(
            this.kind,
            this.primitive,
            this.refName,
            this.items,
            this.values,
            this.enumValues,
            this.unionRefNames,
            true,
            this.unmappedText,
        );
    }

    /** True for a numeric leaf — what `@WpMin` / `@WpMax` are allowed to constrain. */
    isNumeric(): boolean {
        return this.kind === 'primitive' && this.primitive === 'number';
    }
}
