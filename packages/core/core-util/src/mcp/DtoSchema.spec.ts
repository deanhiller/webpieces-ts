import { describe, expect, it } from 'vitest';
import {
    ApiJsonSchema,
    ApiJsonSchemaDiscriminator,
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
 * The union half of the validator (#1009). A discriminated union is narrowed the way the SOURCE
 * narrows it — read the discriminator, pick the branch — so a bad value is reported as the wrong
 * FIELD with the legal values beside it, instead of an undifferentiated "no branch matched".
 */
describe('ApiJsonSchemaValidator over a oneOf', () => {
    function branch(kind: string, extra: string): ApiJsonSchema {
        const literal = new ApiJsonSchema('string');
        literal.enum = [kind];
        return new ObjectSchemaBuilder()
            .required('kind', literal)
            .required(extra, stringSchema())
            .build();
    }

    function window(discriminated: boolean): ApiJsonSchema {
        const schema = new ApiJsonSchema();
        schema.oneOf = [branch('scheduled', 'from'), branch('asap', 'estimate')];
        if (discriminated) {
            schema.discriminator = new ApiJsonSchemaDiscriminator('kind', {
                scheduled: 'ScheduledWindow',
                asap: 'AsapWindow',
            });
        }
        return schema;
    }

    function nested(discriminated: boolean): ApiJsonSchema {
        return new ObjectSchemaBuilder().required('window', window(discriminated)).build();
    }

    it('selects the branch the discriminator names and validates against THAT branch', () => {
        const schema = nested(true);

        expect(validator.validate(schema, { window: { kind: 'asap', estimate: '20m' } })).toBe(
            undefined,
        );
        // Selected `asap`, so `from` is not a field of the chosen branch — the report names the
        // extra key rather than blaming the union.
        expect(messageOf(validator.validate(schema, { window: { kind: 'asap', from: 'x' } }))).toBe(
            '$.window.from is not allowed',
        );
    });

    it('names the discriminator FIELD and its legal values when the value matches no branch', () => {
        const failure = validator.validate(nested(true), { window: { kind: 'whenever' } });

        expect(failure?.field).toBe('$.window.kind');
        expect(messageOf(failure)).toBe('$.window.kind must be one of: scheduled | asap');
    });

    it('says the same thing when the discriminator property is ABSENT entirely', () => {
        expect(messageOf(validator.validate(nested(true), { window: { from: 'x' } }))).toBe(
            '$.window.kind must be one of: scheduled | asap',
        );
    });

    it('accepts any matching branch of a union published WITHOUT a discriminator', () => {
        const schema = nested(false);

        expect(validator.validate(schema, { window: { kind: 'asap', estimate: '20m' } })).toBe(
            undefined,
        );
        expect(messageOf(validator.validate(schema, { window: { kind: 'asap' } }))).toBe(
            '$.window matches none of the 2 accepted shapes',
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
