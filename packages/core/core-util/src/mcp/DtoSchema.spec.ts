import { describe, expect, it } from 'vitest';
import {
    ApiJsonSchema,
    ApiJsonSchemaValidator,
    DtoValidationFailure,
    ObjectSchemaBuilder,
} from './DtoSchema';

const validator = new ApiJsonSchemaValidator();

function stringSchema(): ApiJsonSchema {
    return new ApiJsonSchema('string');
}

function messageOf(failure: DtoValidationFailure | undefined): string {
    return failure?.message ?? '';
}

describe('ApiJsonSchema', () => {
    it('carries a nullable type as [T, "null"] and answers both halves of it', () => {
        const nullable = new ApiJsonSchema(['string', 'null']);

        expect(ApiJsonSchema.baseTypeOf(nullable)).toBe('string');
        expect(ApiJsonSchema.allowsNull(nullable)).toBe(true);
        expect(ApiJsonSchema.allowsNull(stringSchema())).toBe(false);
        expect(ApiJsonSchema.baseTypeOf(stringSchema())).toBe('string');
    });

    it('counts a typed map as CLOSED, not only additionalProperties: false', () => {
        const closed = new ObjectSchemaBuilder().build();
        const typedMap = new ApiJsonSchema('object');
        typedMap.additionalProperties = stringSchema();
        const open = new ApiJsonSchema('object');

        expect(ApiJsonSchema.isClosed(closed)).toBe(true);
        expect(ApiJsonSchema.isClosed(typedMap)).toBe(true);
        expect(ApiJsonSchema.isClosed(open)).toBe(false);
    });
});

describe('ObjectSchemaBuilder', () => {
    it('builds a closed object, listing only the required names', () => {
        const schema = new ObjectSchemaBuilder()
            .required('value', stringSchema())
            .optional('note', stringSchema())
            .build();

        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(['value']);
        expect(Object.keys(schema.properties ?? {})).toEqual(['value', 'note']);
    });

    it('omits `required` entirely when every field is optional', () => {
        expect(new ObjectSchemaBuilder().optional('note', stringSchema()).build().required).toBe(
            undefined,
        );
    });
});

describe('ApiJsonSchemaValidator', () => {
    const schema = new ObjectSchemaBuilder()
        .required('name', stringSchema())
        .optional('count', new ApiJsonSchema('integer'))
        .build();

    it('accepts a value matching the schema', () => {
        expect(validator.validate(schema, { name: 'a', count: 2 })).toBe(undefined);
    });

    it('names the missing required field with its JSON path', () => {
        const failure = validator.validate(schema, {});

        expect(failure?.field).toBe('$.name');
        expect(messageOf(failure)).toBe('$.name is required');
    });

    it('rejects a key the closed schema does not declare', () => {
        expect(messageOf(validator.validate(schema, { name: 'a', other: 1 }))).toBe(
            '$.other is not allowed',
        );
    });

    it('rejects a non-integer where the schema says integer', () => {
        expect(messageOf(validator.validate(schema, { name: 'a', count: 1.5 }))).toBe(
            '$.count must be an integer',
        );
    });

    it('enforces minimum and maximum', () => {
        const bounded = new ApiJsonSchema('number');
        bounded.minimum = 1;
        bounded.maximum = 10;

        expect(messageOf(validator.validate(bounded, 0))).toBe('$ must be >= 1');
        expect(messageOf(validator.validate(bounded, 11))).toBe('$ must be <= 10');
    });

    it('enforces an enum, listing the allowed values', () => {
        const phase = stringSchema();
        phase.enum = ['open', 'closed'];

        expect(messageOf(validator.validate(phase, 'other'))).toBe(
            '$ must be one of: open, closed',
        );
    });

    it('walks array items and reports the offending index', () => {
        const list = new ApiJsonSchema('array');
        list.items = stringSchema();

        expect(messageOf(validator.validate(list, ['a', 2]))).toBe('$[1] must be a string');
    });

    it('typechecks every value of a typed map and allows its open key set', () => {
        const map = new ApiJsonSchema('object');
        map.additionalProperties = stringSchema();

        expect(validator.validate(map, { anything: 'a' })).toBe(undefined);
        expect(messageOf(validator.validate(map, { anything: 3 }))).toBe(
            '$.anything must be a string',
        );
    });

    it('distinguishes NULLABLE from OPTIONAL, which the reflect-metadata runtime could not', () => {
        const nullable = new ObjectSchemaBuilder()
            .required('externalId', new ApiJsonSchema(['string', 'null']))
            .build();

        expect(validator.validate(nullable, { externalId: null })).toBe(undefined);
        expect(messageOf(validator.validate(nullable, {}))).toBe('$.externalId is required');
        expect(messageOf(validator.validate(schema, { name: null }))).toBe(
            '$.name must not be null',
        );
    });
});

/**
 * #984 deleted the runtime spelling of every DTO field fact. These are the symbols that went, and
 * this spec exists so re-adding one to the barrel turns red rather than quietly reopening the second
 * spelling (`.claude/rules/no-backwards-compat.md`).
 */
describe('the deleted reflect-metadata DTO surface', () => {
    it('exports none of the removed symbols from @webpieces/core-util', async () => {
        const barrel: Record<string, unknown> = await import('../index');

        for (const removed of [
            'WpDto',
            'WpDtoField',
            'WpDtoFieldOptions',
            'WpDtoMapFieldOptions',
            'WpDtoFieldMetadata',
            'WpMcpHeader',
            'WpResponseDto',
            'DtoSchemaBuilder',
            'WpMcpToolOptions',
        ]) {
            expect(Object.hasOwn(barrel, removed)).toBe(false);
        }
    });
});
