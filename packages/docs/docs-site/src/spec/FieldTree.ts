import { JsonEntry, JsonNode } from './JsonNode';
import { NamedSchema } from './ApiSpec';
import { SchemaLens } from './SchemaLens';
import { SchemaShape } from './SchemaShape';

/**
 * One row of the parameter tree: the field name, the type label, the prose, and — for an enum — the
 * COMPLETE list of possible values. All four are read from the spec; none is authored here.
 */
export class FieldNode {
    constructor(
        readonly name: string,
        readonly typeLabel: string,
        readonly description: string,
        readonly required: boolean,
        readonly possibleValues: readonly string[],
        /** The named object this field's type is, when it has a page of its own. Else `undefined`. */
        readonly linkTo: NamedSchema | undefined,
        readonly children: readonly FieldNode[],
    ) {}
}

/**
 * One branch of a `oneOf` request body, keyed by its discriminator value.
 *
 * Every branch renders EXPANDED, one after another, rather than behind tabs. A partner writing one
 * handler needs every shape at once — and a tab is invisible to Ctrl-F and to print, so the shapes
 * behind the unselected tabs are, for a reader searching the page, simply not documented.
 */
export class SchemaVariant {
    constructor(
        readonly label: string,
        readonly discriminatorValue: string,
        readonly fields: readonly FieldNode[],
    ) {}
}

/**
 * Builds the parameter tree.
 *
 * ## Two trees on purpose: links here, full resolution in the example
 *
 * Every reference to a named OBJECT renders as a LINK to that object's own page, and the field's
 * children are NOT inlined underneath it — the link IS the expansion. The generated example body
 * (see `ExampleBuilder`) resolves the same references fully instead.
 *
 * Sharing one tree between them is the tempting simplification and it is wrong in both directions.
 * A hyperlink cannot live inside a JSON sample, so a shared tree that links prints `"data": {}` on a
 * partner's page; a shared tree that inlines gives every DTO as many copies as it has use sites, and
 * none of them is the page a reader can link to.
 *
 * A named ENUM or scalar alias is NOT linked — it renders inline with its chips, because a page
 * carrying one line of values costs the reader the context they were already reading.
 */
export class FieldTreeBuilder {
    private readonly shape = new SchemaShape();

    constructor(private readonly lens: SchemaLens) {}

    /** The fields of a schema — its own, plus every `allOf` branch's, in declaration order. */
    fieldsOf(schema: JsonNode): readonly FieldNode[] {
        const resolved = this.lens.resolve(schema);
        const fields: FieldNode[] = [];
        for (const branch of resolved.list('allOf')) {
            fields.push(...this.fieldsOf(branch));
        }
        const required = this.requiredNamesOf(resolved);
        for (const property of resolved.at('properties').entries()) {
            fields.push(this.fieldOf(property, required.includes(property.key)));
        }
        return fields;
    }

    /**
     * The `oneOf` branches of a schema, labelled by the discriminator value that selects each one.
     * Empty when the schema is not a union, which is what tells a renderer to draw one flat tree.
     */
    variantsOf(schema: JsonNode): readonly SchemaVariant[] {
        const branches = this.lens.branchesOf(schema);
        if (branches.length === 0) {
            return [];
        }
        const mapping = this.lens.resolve(schema).at('discriminator').at('mapping');
        const variants: SchemaVariant[] = [];
        for (const branch of branches) {
            const label = this.lens.label(branch);
            variants.push(
                new SchemaVariant(
                    label,
                    this.discriminatorValueOf(mapping, label),
                    this.fieldsOf(branch),
                ),
            );
        }
        return variants;
    }

    /** The `propertyName` a discriminated union switches on, or the empty string when there is none. */
    discriminatorPropertyOf(schema: JsonNode): string {
        return this.lens.resolve(schema).at('discriminator').text('propertyName') ?? '';
    }

    private discriminatorValueOf(mapping: JsonNode, typeName: string): string {
        for (const entry of mapping.entries()) {
            const pointer = entry.value.asText();
            if (pointer !== undefined && pointer.endsWith(`/${typeName}`)) {
                return entry.key;
            }
        }
        return '';
    }

    private fieldOf(property: JsonEntry, required: boolean): FieldNode {
        const named = this.lens.named(property.value);
        const linked = named !== undefined && named.hasOwnPage ? named : undefined;
        return new FieldNode(
            property.key,
            this.lens.label(property.value),
            this.lens.describe(property.value),
            required,
            this.lens.enumValuesOf(property.value),
            linked ?? this.linkedItemOf(property.value),
            linked === undefined ? this.childrenOf(property.value) : [],
        );
    }

    /** For `array<Order>`, the page `Order` lives on — the row links, the array bracket does not. */
    private linkedItemOf(property: JsonNode): NamedSchema | undefined {
        if (this.shape.declaredType(this.lens.resolve(property)) !== 'array') {
            return undefined;
        }
        const named = this.lens.named(this.lens.resolve(property).at('items'));
        return named !== undefined && named.hasOwnPage ? named : undefined;
    }

    /**
     * The nested rows of an INLINE shape — an anonymous object, or an array of one. A named object
     * never gets children here; it got a link instead, which is what stops this recursing forever
     * on a self-referential DTO.
     */
    private childrenOf(property: JsonNode): readonly FieldNode[] {
        const resolved = this.lens.resolve(property);
        if (this.shape.declaredType(resolved) === 'array') {
            const items = resolved.at('items');
            return this.lens.named(items) === undefined ? this.fieldsOf(items) : [];
        }
        if (resolved.at('properties').isObject()) {
            return this.fieldsOf(resolved);
        }
        return [];
    }

    private requiredNamesOf(schema: JsonNode): readonly string[] {
        const names: string[] = [];
        for (const entry of schema.list('required')) {
            const name = entry.asText();
            if (name !== undefined) {
                names.push(name);
            }
        }
        return names;
    }
}
