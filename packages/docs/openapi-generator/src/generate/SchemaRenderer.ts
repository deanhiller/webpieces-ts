import { DocumentedField, DocumentedType, TypeRef } from '@webpieces/api-doc-model';
import { JsonObject, JsonValue } from '../json/JsonObject';

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
 */
export class SchemaRenderer {
    private readonly reached = new Set<string>();
    private readonly unmappedFields: UnmappedField[] = [];

    constructor(private readonly types: ReadonlyMap<string, DocumentedType>) {}

    /** Named types this renderer has been asked for, directly or through another schema. */
    reachedTypes(): ReadonlySet<string> {
        return this.reached;
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
            for (const name of Array.from(this.reached)) {
                if (rendered.has(name)) {
                    continue;
                }
                const type = this.types.get(name);
                // Rendering it can add MORE names to `reached`, which is what the outer loop is for.
                rendered.set(name, type === undefined ? undefined : this.namedType(type));
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

    /** One named type: an object DTO, a string enum, or a union with its DERIVED discriminator. */
    private namedType(type: DocumentedType): JsonObject {
        const pointer = `#/components/schemas/${type.name}`;
        if (type.enumValues.length > 0) {
            return new JsonObject()
                .set('type', 'string')
                .set('description', this.prose(type.description))
                .set('enum', type.enumValues.slice());
        }
        if (type.unionRefNames.length > 0) {
            return this.union(type);
        }
        const properties = new JsonObject();
        const required: string[] = [];
        for (const field of type.fields) {
            properties.set(field.name, this.field(field, `${pointer}/properties/${field.name}`));
            if (!field.optional) {
                required.push(field.name);
            }
        }
        return new JsonObject()
            .set('type', 'object')
            .set('description', this.prose(type.description))
            .set('properties', properties.isEmpty() ? undefined : properties)
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
     * branch carries the same property typed as a single string literal. An invented discriminator
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
        for (const branch of type.unionRefNames) {
            const value = type.discriminator.branchValues.get(branch);
            if (value !== undefined) {
                mapping.set(value, `#/components/schemas/${branch}`);
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

    private reference(name: string): JsonObject {
        this.reached.add(name);
        return new JsonObject().set('$ref', `#/components/schemas/${name}`);
    }

    /** Empty prose is ABSENT prose. An empty `description` key is noise in every rendered page. */
    private prose(text: string | undefined): string | undefined {
        return text === undefined || text.trim() === '' ? undefined : text;
    }
}
