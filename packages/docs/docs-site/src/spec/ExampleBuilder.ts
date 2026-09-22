import { JsonMap, JsonNode, JsonValue } from './JsonNode';
import { SchemaLens } from './SchemaLens';
import { SchemaShape } from './SchemaShape';

/**
 * Builds the example body a code sample sends, FULLY RESOLVED — every `$ref` followed, because a
 * hyperlink cannot live inside a JSON sample and a partner copying one needs every nested field.
 *
 * ## Cycle safety includes the ROOT
 *
 * A schema is marked seen BEFORE its own properties are read, not after. Mark it afterwards and a
 * self-referential DTO — `Category { parent: Category }`, or any pair that refers to each other —
 * recurses until the stack dies, and the failure is a crash with no pointer in it rather than a
 * page. A second visit renders `{}`, which is honest: the sample is showing the shape once.
 *
 * The values are DERIVED, never invented prose: an enum's first published value, a `date-time`'s
 * canonical spelling, the field's own name for a free string. A sample that made up plausible
 * content would read as data a partner can expect us to return.
 */
export class ExampleBuilder {
    private readonly shape = new SchemaShape();

    constructor(private readonly lens: SchemaLens) {}

    /** The example body for a schema, or `undefined` when there is no schema to build one from. */
    build(schema: JsonNode | undefined): JsonValue | undefined {
        if (schema === undefined) {
            return undefined;
        }
        return this.valueOf(schema, '', new Set<string>());
    }

    private valueOf(schema: JsonNode, fieldName: string, seen: ReadonlySet<string>): JsonValue {
        const target = this.lens.refTargetOf(schema);
        if (target !== undefined) {
            if (seen.has(target.name)) {
                return {};
            }
            const deeper = new Set<string>(seen);
            deeper.add(target.name);
            return this.valueOf(this.lens.resolve(schema), fieldName, deeper);
        }
        return this.inlineValueOf(schema, fieldName, seen);
    }

    private inlineValueOf(
        schema: JsonNode,
        fieldName: string,
        seen: ReadonlySet<string>,
    ): JsonValue {
        const branches = schema.list('oneOf');
        if (branches.length > 0) {
            return this.valueOf(branches[0]!, fieldName, seen);
        }
        const merged = schema.list('allOf');
        if (merged.length > 0) {
            return this.mergedValueOf(merged, fieldName, seen);
        }
        const enumValues = this.lens.enumValuesOf(schema);
        if (enumValues.length > 0) {
            return enumValues[0]!;
        }
        return this.typedValueOf(schema, fieldName, seen);
    }

    private mergedValueOf(
        branches: readonly JsonNode[],
        fieldName: string,
        seen: ReadonlySet<string>,
    ): JsonValue {
        const merged: JsonMap = {};
        for (const branch of branches) {
            const value = this.valueOf(branch, fieldName, seen);
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                Object.assign(merged, value);
            }
        }
        return merged;
    }

    private typedValueOf(
        schema: JsonNode,
        fieldName: string,
        seen: ReadonlySet<string>,
    ): JsonValue {
        const declared = this.shape.declaredType(schema);
        if (declared === 'array') {
            return [this.valueOf(schema.at('items'), fieldName, seen)];
        }
        if (declared === 'object' || schema.at('properties').isObject()) {
            return this.objectValueOf(schema, seen);
        }
        if (declared === 'integer' || declared === 'number') {
            return 0;
        }
        if (declared === 'boolean') {
            return true;
        }
        return this.stringValueOf(schema, fieldName);
    }

    private objectValueOf(schema: JsonNode, seen: ReadonlySet<string>): JsonValue {
        const body: JsonMap = {};
        for (const property of schema.at('properties').entries()) {
            body[property.key] = this.valueOf(property.value, property.key, seen);
        }
        if (
            schema.at('properties').entries().length === 0 &&
            schema.at('additionalProperties').isObject()
        ) {
            body['key'] = this.valueOf(schema.at('additionalProperties'), 'value', seen);
        }
        return body;
    }

    private stringValueOf(schema: JsonNode, fieldName: string): JsonValue {
        const format = schema.text('format');
        if (format === 'date-time') {
            return '2026-01-31T09:30:00Z';
        }
        if (format === 'date') {
            return '2026-01-31';
        }
        if (format === 'uuid') {
            return '00000000-0000-0000-0000-000000000000';
        }
        return fieldName === '' ? 'string' : fieldName;
    }

    /** The sample serialization: two-space JSON, which is what a partner pastes into their client. */
    render(value: JsonValue | undefined): string {
        if (value === undefined) {
            return '';
        }
        return JSON.stringify(value, null, 2);
    }
}
