import { DocumentedField, DocumentedType, TypeRef } from '@webpieces/api-doc-model';
import { JsonObject, JsonValue } from '../json/JsonObject';
import { InlinedWrappers } from './InlinedWrappers';
import { SchemaPlacement } from './SchemaPlacement';

/** ONE field the renderer could not give a shape to, and WHERE in the document it would have sat. */
export class UnmappedField {
    constructor(
        /** A JSON pointer into the document that would have been written. */
        readonly pointer: string,
        /** The verbatim TypeScript type text, so the cure names the thing to go and type. */
        readonly typeText: string,
    ) {}
}

/**
 * {@link TypeRef} / {@link DocumentedType} -> JSON Schema 2020-12, which IS OpenAPI 3.1's schema
 * dialect and IS what MCP `tools/list` speaks. That identity is the reason #982 specifies 3.1 rather
 * than 3.0: the two are not "similar dialects", they are the same schemas, so the MCP projection
 * (#984) is a selection and an inline pass, not a translation.
 *
 * ## Three things 3.1 lets this renderer state HONESTLY that 3.0 could not
 *
 * - `type: [T, "null"]` for a nullable field, instead of 3.0's `nullable: true` keyword, which is not
 *   JSON Schema at all.
 * - `description` BESIDE a `$ref`. In 3.0 a sibling of `$ref` is ignored, so a documented field whose
 *   type is a named DTO simply lost its prose.
 * - OPTIONAL and NULLABLE as separate facts — absent from `required` versus `"null"` in `type`. `{}`
 *   and `{x: null}` are different wire documents and a schema that conflates them rejects one.
 *
 * ## It records what it cannot map rather than emitting an untyped field
 *
 * An unmapped type yields an EMPTY schema, which in JSON Schema means "anything". That is precisely
 * the green-build-publishes-a-shapeless-field defect the guard exists to stop, so every one is
 * recorded with the pointer it would have occupied and {@link OpenApiGenerator} refuses on the set.
 *
 * ## WHERE a schema is defined is the placement's answer, not this class's (#1058)
 *
 * The {@link SchemaPlacement} decides, per type, whether its schema is defined in THIS document's
 * `components.schemas` (and under which name) or referenced in another package's components
 * document. Every `$ref` — a field, an array item, a union branch, a discriminator `mapping` entry —
 * is written through it, so the split, the bundled and the MCP document are one renderer.
 *
 * ## A single-use request/response wrapper is written INLINE at its operation (#1303)
 *
 * {@link body} is how an operation asks for its request or success-response schema. A wrapper
 * {@link InlinedWrappers} names is rendered right there — `title` set to its published name, its
 * description, and `properties` even when empty — instead of as a `$ref`; it is never added to
 * `components.schemas`. It is recorded in {@link inlinedTypes} so the description guard still judges
 * it: inlining is never a way around a missing JSDoc.
 *
 * ## A `@hidden` field is never rendered into the customer document (#1246)
 *
 * With `dropsHiddenFields`, an object schema simply skips the field — its property, its prose, its
 * `required` entry — wherever that schema is written: a component, an inlined wrapper, a webhook
 * payload, a nested `$ref` target. Nothing is built and then removed.
 */
export class SchemaRenderer {
    private readonly reached = new Set<string>();
    private readonly inlined = new Set<string>();
    private readonly external = new Set<string>();
    private readonly unmappedFields: UnmappedField[] = [];

    constructor(
        /** The model's named types, by key (`DocumentedType.keyOf`). */
        private readonly types: ReadonlyMap<string, DocumentedType>,
        private readonly placement: SchemaPlacement,
        /** The wrappers an operation defines inline rather than by `$ref` (#1303). */
        private readonly wrappers: InlinedWrappers,
        /**
         * Omit every `@hidden` field (#1246) — the customer document alone. The field is never
         * rendered, so a type reached ONLY through it is never reached either: select-then-render,
         * exactly as for a hidden method (see `DocumentSelection`).
         */
        private readonly dropsHiddenFields: boolean,
    ) {}

    /** Keys of the named types this document DEFINES, reached directly or through another schema. */
    reachedTypes(): ReadonlySet<string> {
        return this.reached;
    }

    /** Keys of the wrappers this document defined INLINE at their one operation (#1303). */
    inlinedTypes(): ReadonlySet<string> {
        return this.inlined;
    }

    /** Keys of the named types this document REFERENCES in another package's components document. */
    externalTypes(): ReadonlySet<string> {
        return this.external;
    }

    /** Every field with no shape, with its pointer. Empty means the document is fully typed. */
    unmapped(): readonly UnmappedField[] {
        return this.unmappedFields;
    }

    /**
     * `components.schemas` for everything reachable from whatever has been rendered so far, expanded
     * to a FIXPOINT.
     *
     * A worklist and not recursion-with-a-guard because rendering a type reaches more types, and the
     * set has to close over that. It terminates for the same reason the extractor's walk does: a
     * named type is registered once, so the worklist strictly shrinks.
     */
    components(): JsonObject {
        const rendered = new Map<string, JsonObject | undefined>();
        let grew = true;
        while (grew) {
            grew = false;
            for (const key of Array.from(this.reached)) {
                const type = this.types.get(key);
                const name = type === undefined ? key : this.placement.localName(key, type);
                if (rendered.has(name)) {
                    continue;
                }
                // Rendering it can add MORE names to `reached`, which is what the outer loop is for.
                rendered.set(
                    name,
                    type === undefined
                        ? undefined
                        : this.namedType(
                              type,
                              `#/components/schemas/${this.placement.localName(key, type)}`,
                          ),
                );
                grew = true;
            }
        }
        const schemas = new JsonObject();
        // Alphabetical, because `components.schemas` is a lookup table and nothing reads it in order
        // — whereas discovery order would move every time an operation was added above another.
        for (const name of Array.from(rendered.keys()).sort()) {
            schemas.set(name, rendered.get(name));
        }
        return schemas;
    }

    /**
     * Mark `key` as DEFINED by this document even when nothing in it refers to the type — the
     * components document of a DTO library publishes every type the library exports (#1058).
     */
    define(key: string): void {
        const type = this.types.get(key);
        if (type !== undefined && this.placement.isLocal(key, type)) {
            this.reached.add(key);
        }
    }

    /**
     * An operation's request body or success-response schema: the wrapper itself, INLINE, when
     * {@link InlinedWrappers} names it — else exactly what {@link type} writes.
     *
     * The inline form is an object schema carrying `title` (the PUBLISHED name, which client
     * generators name the model from) and `properties` even when the class is empty, which a client
     * generator needs in order to emit an empty class rather than an untyped map.
     */
    body(ref: TypeRef, pointer: string): JsonObject {
        const key = ref.kind === 'ref' ? ref.refName! : undefined;
        const type = key === undefined ? undefined : this.types.get(key);
        if (key === undefined || type === undefined || !this.wrappers.has(key)) {
            return this.type(ref, pointer);
        }
        this.inlined.add(key);
        return this.objectType(type, pointer, type.schemaName);
    }

    /** One named type: an object DTO, a string enum, or a union with its DERIVED discriminator. */
    private namedType(type: DocumentedType, pointer: string): JsonObject {
        if (type.enumValues.length > 0) {
            return new JsonObject()
                .set('type', 'string')
                .set('description', this.prose(type.description))
                .set('enum', type.enumValues.slice());
        }
        if (type.unionRefNames.length > 0) {
            return this.union(type);
        }
        return this.objectType(type, pointer, undefined);
    }

    /**
     * An object DTO. `title` is set only on an INLINED wrapper, and then `properties` is written even
     * when empty (#1303); a component keeps its name as its key and omits an empty `properties`.
     */
    private objectType(type: DocumentedType, pointer: string, title: string | undefined): JsonObject {
        const properties = new JsonObject();
        const required: string[] = [];
        for (const field of type.fields) {
            if (this.dropsHiddenFields && field.hidden) {
                continue;
            }
            properties.set(field.name, this.field(field, `${pointer}/properties/${field.name}`));
            if (!field.optional) {
                required.push(field.name);
            }
        }
        return new JsonObject()
            .set('type', 'object')
            .set('title', title)
            .set('description', this.prose(type.description))
            .set('properties', properties.isEmpty() && title === undefined ? undefined : properties)
            .set('required', required.length === 0 ? undefined : required)
            .set(
                'additionalProperties',
                type.indexSignatureValue === undefined
                    ? undefined
                    : this.type(type.indexSignatureValue, `${pointer}/additionalProperties`),
            );
    }

    /**
     * A union, with a `discriminator` ONLY when the model derived one — which it does only when every
     * branch carries the same property typed as string values (a literal, a string-enum member, or a
     * union of them) that no two branches share. An invented discriminator
     * would claim a narrowing TypeScript itself cannot do.
     */
    private union(type: DocumentedType): JsonObject {
        const branches: JsonValue[] = type.unionRefNames.map((name: string) =>
            this.reference(name),
        );
        const schema = new JsonObject()
            .set('description', this.prose(type.description))
            .set('oneOf', branches);
        if (type.discriminator === undefined) {
            return schema;
        }
        const mapping = new JsonObject();
        // EVERY value a branch's property may hold maps to that branch — `mode: 'a' | 'b'` is two
        // entries pointing at one schema, which OpenAPI's mapping allows (#1023).
        for (const branch of type.unionRefNames) {
            for (const value of type.discriminator.branchValues.get(branch) ?? []) {
                mapping.set(value, this.pointerTo(branch));
            }
        }
        return schema.set(
            'discriminator',
            new JsonObject()
                .set('propertyName', type.discriminator.propertyName)
                .set('mapping', mapping),
        );
    }

    /**
     * One FIELD: its type, plus the prose and the constraints that hang off the field rather than the
     * type. `@format`, `@WpMin` and `@WpMax` land on the SCALAR — on an array, on the ITEM — because
     * `minimum` on an array means nothing and a reader would have to guess which half was meant.
     */
    field(field: DocumentedField, pointer: string): JsonObject {
        const isArray = field.type.kind === 'array';
        const leafPointer = isArray ? `${pointer}/items` : pointer;
        const leaf = this.constrain(
            isArray ? this.type(field.type.items!, leafPointer) : this.type(field.type, pointer),
            field,
        );
        const schema = isArray
            ? new JsonObject().set('type', 'array').set('items', leaf)
            : this.nullable(leaf, field.nullable);
        if (isArray && field.nullable) {
            return this.described(this.nullable(schema, true), field);
        }
        return this.described(schema, field);
    }

    /** `description`, and the `@mcp` override as `x-mcp-description` when the author wrote one. */
    private described(schema: JsonObject, field: DocumentedField): JsonObject {
        return schema
            .set('description', this.prose(field.description))
            .set('x-mcp-description', this.prose(field.mcpDescription));
    }

    private constrain(leaf: JsonObject, field: DocumentedField): JsonObject {
        return leaf.set('format', field.format).set('minimum', field.min).set('maximum', field.max);
    }

    /** `type: [T, "null"]` where there is a type to widen; `anyOf` where the shape is a `$ref`. */
    private nullable(schema: JsonObject, isNullable: boolean): JsonObject {
        if (!isNullable) {
            return schema;
        }
        const declared = schema.get('type');
        if (typeof declared === 'string') {
            const values = schema.get('enum');
            if (Array.isArray(values) && !values.includes(null)) {
                // `enum` is checked independently of `type`, so a nullable inline enum
                // (`'a' | 'b' | null`) must list `null` too or the document rejects it (#1197).
                schema.set('enum', [...values, null]);
            }
            return schema.set('type', [declared, 'null']);
        }
        return new JsonObject().set('anyOf', [schema, new JsonObject().set('type', 'null')]);
    }

    /** One resolved type, with no field-level prose or constraints on it. */
    type(ref: TypeRef, pointer: string): JsonObject {
        switch (ref.kind) {
            case 'primitive':
                return this.primitive(ref);
            case 'ref':
                return this.reference(ref.refName!);
            case 'array':
                return new JsonObject()
                    .set('type', 'array')
                    .set('items', this.type(ref.items!, `${pointer}/items`));
            case 'openMap':
                return new JsonObject()
                    .set('type', 'object')
                    .set(
                        'additionalProperties',
                        this.type(ref.values!, `${pointer}/additionalProperties`),
                    );
            case 'enum':
                return new JsonObject().set('type', 'string').set('enum', ref.enumValues.slice());
            case 'union':
                return this.namedUnion(ref);
            default:
                this.unmappedFields.push(
                    new UnmappedField(pointer, ref.unmappedText ?? '<unknown>'),
                );
                return new JsonObject();
        }
    }

    /**
     * A union, as a `$ref` at the NAMED alias when the model registered one.
     *
     * The model records a `type X = A | B` alias as its own entry — carrying the DERIVED
     * discriminator — while the FIELD that used it holds a bare union of branch names. Rendering the
     * field's union inline would therefore publish the `oneOf` and silently drop the discriminator,
     * which is the one part of a union a client actually needs to narrow on. So the alias is looked
     * up by its branch list and referenced.
     */
    private namedUnion(ref: TypeRef): JsonObject {
        const branches = ref.unionRefNames.join(',');
        for (const name of Array.from(this.types.keys())) {
            if (this.types.get(name)!.unionRefNames.join(',') === branches) {
                return this.reference(name);
            }
        }
        return new JsonObject().set(
            'oneOf',
            ref.unionRefNames.map((each: string) => this.reference(each)),
        );
    }

    private primitive(ref: TypeRef): JsonObject {
        if (ref.primitive === 'unknown') {
            // No `type` at all: JSON Schema's honest spelling of "any shape". It is only ever reached
            // by a `void` return, which is why it is not the unmapped refusal.
            return new JsonObject();
        }
        return new JsonObject().set('type', ref.integer ? 'integer' : ref.primitive!);
    }

    /**
     * A `$ref` to the type registered under `key`, recording whether this document defines it or
     * references it in its declaring package's components document.
     */
    private reference(key: string): JsonObject {
        return new JsonObject().set('$ref', this.pointerTo(key));
    }

    private pointerTo(key: string): string {
        const type = this.types.get(key);
        if (type === undefined) {
            // Not in the model at all (a manifest naming an error type that does not exist): keep it
            // local so `components()` writes the hole the guards then name.
            this.reached.add(key);
            return `#/components/schemas/${key}`;
        }
        if (this.placement.isLocal(key, type)) {
            this.reached.add(key);
        } else {
            this.external.add(key);
        }
        return this.placement.pointer(key, type);
    }

    /** Empty prose is ABSENT prose. An empty `description` key is noise in every rendered page. */
    private prose(text: string | undefined): string | undefined {
        return text === undefined || text.trim() === '' ? undefined : text;
    }
}
