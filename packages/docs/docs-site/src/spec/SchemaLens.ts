import { ApiSpec, NamedSchema } from './ApiSpec';
import { JsonNode } from './JsonNode';
import { SchemaShape } from './SchemaShape';

/** What a `$ref` (in any of its three spellings) points at, plus whether the site said it may be null. */
export class RefTarget {
    constructor(
        readonly name: string,
        readonly nullable: boolean,
    ) {}
}

const SCHEMA_POINTER = '#/components/schemas/';

/**
 * Everything "what does this schema node SAY" — reference reading and the type label.
 *
 * ## A reference arrives in three shapes, and reading only `$ref` drops two
 *
 * | shape | written by |
 * |---|---|
 * | `{ "$ref": "…", "description": "…" }` | OpenAPI 3.1, where prose beside a `$ref` is legal |
 * | `{ "anyOf": [{ "$ref": "…" }, { "type": "null" }] }` | OpenAPI 3.1's nullable reference |
 * | `{ "allOf": [{ "$ref": "…" }], "description": "…" }` | OpenAPI 3.0, whose `$ref` siblings are ignored |
 *
 * All three render, because this package renders any conforming document and the third one is what
 * every 3.0 generator in the world emits. Reading only the first would silently drop a field's whole
 * type on a 3.0 document — the field would render with no type at all, which a reader reads as "we
 * forgot to document it".
 */
export class SchemaLens {
    private readonly shape = new SchemaShape();

    constructor(private readonly spec: ApiSpec) {}

    /** What a node says about itself, with no catalog needed — see {@link SchemaShape}. */
    shapeOf(): SchemaShape {
        return this.shape;
    }

    /** The reference this node makes, in whichever of the three shapes it was written. */
    refTargetOf(node: JsonNode): RefTarget | undefined {
        const direct = this.nameOfPointer(node.text('$ref'));
        if (direct !== undefined) {
            return new RefTarget(direct, this.shape.isNullable(node));
        }
        const wrapped = this.singleRefIn(node.list('allOf'));
        if (wrapped !== undefined) {
            return new RefTarget(wrapped, this.shape.isNullable(node));
        }
        const nullable = this.singleRefIn(node.list('anyOf'));
        if (nullable !== undefined) {
            return new RefTarget(nullable, true);
        }
        return undefined;
    }

    /**
     * The schema a node ultimately describes: the reference target when it is one, else the node.
     * An UNDEFINED `$ref` resolves to the node itself, so a dangling pointer renders inline as
     * whatever it says rather than becoming a dead link.
     */
    resolve(node: JsonNode): JsonNode {
        const target = this.refTargetOf(node);
        if (target === undefined) {
            return node;
        }
        const named = this.spec.schemaNamed(target.name);
        return named === undefined ? node : named.node;
    }

    /** The named schema a node refers to, when the document actually defines it. */
    named(node: JsonNode): NamedSchema | undefined {
        const target = this.refTargetOf(node);
        if (target === undefined) {
            return undefined;
        }
        return this.spec.schemaNamed(target.name);
    }

    /** The prose for a field: what the USE SITE says, falling back to what the TYPE says. */
    describe(node: JsonNode): string {
        const own = node.text('description');
        if (own !== undefined && own !== '') {
            return own;
        }
        const named = this.named(node);
        return named === undefined ? '' : (named.node.text('description') ?? '');
    }

    /**
     * The type label a reader sees. `format` renders inside angle brackets — `string<date-time>` —
     * so the format is visibly a refinement of the type rather than a second type.
     */
    label(node: JsonNode): string {
        const named = this.named(node);
        if (named !== undefined) {
            return named.name;
        }
        const target = this.refTargetOf(node);
        if (target !== undefined) {
            return target.name;
        }
        return this.labelOfInline(node);
    }

    private labelOfInline(node: JsonNode): string {
        const declared = this.shape.declaredType(node);
        if (declared === 'array') {
            return `array<${this.label(node.at('items'))}>`;
        }
        if (declared === 'object' && node.at('additionalProperties').isObject()) {
            return `map<string, ${this.label(node.at('additionalProperties'))}>`;
        }
        const branches = this.branchesOf(node);
        if (branches.length > 0) {
            return branches.map((branch: JsonNode): string => this.label(branch)).join(' | ');
        }
        const format = node.text('format');
        if (declared !== undefined && format !== undefined) {
            return `${declared}<${format}>`;
        }
        return declared ?? 'object';
    }

    /** The `oneOf` branches of a node, resolved through a `$ref` if it is one. Empty when it is not a union. */
    branchesOf(node: JsonNode): readonly JsonNode[] {
        const resolved = this.resolve(node);
        const branches = resolved.list('oneOf');
        return branches.length > 0 ? branches : [];
    }

    /** The complete `Possible values:` list, from the node or from the type it refers to. */
    enumValuesOf(node: JsonNode): readonly string[] {
        const own = this.stringsIn(node.list('enum'));
        if (own.length > 0) {
            return own;
        }
        return this.stringsIn(this.resolve(node).list('enum'));
    }

    private stringsIn(nodes: readonly JsonNode[]): readonly string[] {
        const values: string[] = [];
        for (const entry of nodes) {
            const raw = entry.raw;
            if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
                values.push(String(raw));
            }
        }
        return values;
    }

    private singleRefIn(branches: readonly JsonNode[]): string | undefined {
        for (const branch of branches) {
            const name = this.nameOfPointer(branch.text('$ref'));
            if (name !== undefined) {
                return name;
            }
        }
        return undefined;
    }

    private nameOfPointer(pointer: string | undefined): string | undefined {
        if (pointer === undefined || !pointer.startsWith(SCHEMA_POINTER)) {
            return undefined;
        }
        return pointer.slice(SCHEMA_POINTER.length);
    }
}
