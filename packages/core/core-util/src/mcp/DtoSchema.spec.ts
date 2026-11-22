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

describe('ApiJsonSchema.openForClients (#1441)', () => {
    it('removes additionalProperties:false at every depth, keeps typed maps, and leaves the input closed', () => {
        const branch = new ObjectSchemaBuilder().required('kind', stringSchema()).build();
        const union = new ApiJsonSchema();
        union.oneOf = [branch];
        const item = new ObjectSchemaBuilder().required('window', union).build();
        const list = new ApiJsonSchema('array');
        list.items = item;
        const map = new ApiJsonSchema('object');
        map.additionalProperties = new ObjectSchemaBuilder().required('n', stringSchema()).build();
        const closed = new ObjectSchemaBuilder()
            .required('orders', list)
            .optional('byLocale', map)
            .build();

        const open = ApiJsonSchema.openForClients(closed);

        expect(JSON.stringify(open)).not.toContain('"additionalProperties":false');
        expect(open.required).toEqual(['orders']);
        const openMap = open.properties!['byLocale'];
        expect(ApiJsonSchema.isClosed(openMap)).toBe(true);
        expect((openMap.additionalProperties as ApiJsonSchema).properties).toHaveProperty('n');
        expect(open.properties!['orders'].items!.properties!['window'].oneOf![0].required).toEqual([
            'kind',
        ]);
        // The schema the server validates against is untouched.
        expect(closed.additionalProperties).toBe(false);
        expect(branch.additionalProperties).toBe(false);
        // The validator still refuses an undeclared key against the OPENED schema: opening what is
        // published loosens nothing the server checks of its own result.
        expect(messageOf(validator.validate(open, { orders: [], extra: 1 }))).toBe(
            '$.extra is not allowed',
        );
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

    it('checks a NULLABLE enum against its enum as well as its type, as JSON Schema does (#1197)', () => {
        const nullable = new ApiJsonSchema(['string', 'null']);
        nullable.enum = ['open', 'closed', null];
        const nullInTypeOnly = new ApiJsonSchema(['string', 'null']);
        nullInTypeOnly.enum = ['open', 'closed'];
        const required = stringSchema();
        required.enum = ['open', 'closed'];

        expect(validator.validate(nullable, null)).toBe(undefined);
        expect(validator.validate(nullable, 'open')).toBe(undefined);
        expect(messageOf(validator.validate(nullable, 'other'))).toBe(
            '$ must be one of: open, closed, null',
        );
        expect(messageOf(validator.validate(nullInTypeOnly, null))).toBe(
            '$ must be one of: open, closed',
        );
        expect(messageOf(validator.validate(required, null))).toBe('$ must not be null');
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

    /**
     * #1055: a key HOLDING `undefined` is ABSENT, exactly as `JSON.stringify` and the `required`
     * check read it. Server code builds `{ next: hasMore ? cursor : undefined }` idiomatically, and
     * its JSON is valid — refusing the in-memory object failed every such MCP response.
     */
    it('treats an optional key holding undefined as ABSENT, as JSON.stringify does', () => {
        expect(validator.validate(schema, { name: 'a', count: undefined })).toBe(undefined);
    });

    it('treats an undeclared key holding undefined as ABSENT on a closed schema', () => {
        expect(validator.validate(schema, { name: 'a', other: undefined })).toBe(undefined);
    });

    it('still reports a REQUIRED key holding undefined as missing', () => {
        expect(messageOf(validator.validate(schema, { name: undefined }))).toBe(
            '$.name is required',
        );
    });

    it('still refuses null on a non-nullable optional field — null is a value, not an absence', () => {
        expect(messageOf(validator.validate(schema, { name: 'a', count: null }))).toBe(
            '$.count must not be null',
        );
    });
});

/**
 * A `type` ARRAY of several non-null types, and an EXPLICITLY open object (#1447) — the two schema
 * features the recursive JSON marker `JsonValueDto` publishes, so a server can validate a free-form
 * JSON payload without a consumer-side patch.
 */
describe('ApiJsonSchemaValidator over multi-type and explicitly open schemas (#1447)', () => {
    function openJson(): ApiJsonSchema {
        const schema = new ApiJsonSchema(['string', 'number', 'boolean', 'object', 'array', 'null']);
        schema.additionalProperties = true;
        return schema;
    }

    function holding(field: string, value: ApiJsonSchema): ApiJsonSchema {
        return new ObjectSchemaBuilder().required(field, value).build();
    }

    it('accepts every JSON value, nested to any depth, under the open JSON schema', () => {
        const nested = { a: [1, 'two', true, null, { b: { c: [[], {}] } }], d: { e: null } };
        for (const value of ['text', 3.5, false, null, [1, [2, [3]]], nested]) {
            expect(validator.validate(holding('value', openJson()), { value })).toBeUndefined();
        }
    });

    it('accepts a whole number where integer is listed and refuses a fraction', () => {
        const schema = holding('value', new ApiJsonSchema(['integer', 'string']));

        expect(validator.validate(schema, { value: 4 })).toBeUndefined();
        expect(validator.validate(schema, { value: 'four' })).toBeUndefined();
        expect(messageOf(validator.validate(schema, { value: 4.5 }))).toBe(
            '$.value must be one of: integer, string',
        );
    });

    it('refuses a value of a type the array does not list, and null unless listed', () => {
        const schema = holding('value', new ApiJsonSchema(['string', 'number']));

        expect(messageOf(validator.validate(schema, { value: [1] }))).toBe(
            '$.value must be one of: string, number',
        );
        expect(messageOf(validator.validate(schema, { value: { a: 1 } }))).toBe(
            '$.value must be one of: string, number',
        );
        expect(messageOf(validator.validate(schema, { value: null }))).toBe('$.value must not be null');
        const nullable = holding('value', new ApiJsonSchema(['string', 'number', 'null']));
        expect(validator.validate(nullable, { value: null })).toBeUndefined();
    });

    it('still validates the matched member: an object branch obeys its own properties', () => {
        const branch = new ApiJsonSchema(['string', 'object']);
        branch.properties = { id: new ApiJsonSchema('integer') };
        branch.required = ['id'];

        expect(validator.validate(holding('value', branch), { value: { id: 2 } })).toBeUndefined();
        expect(messageOf(validator.validate(holding('value', branch), { value: { id: 'x' } }))).toBe(
            '$.value.id must be a number',
        );
        expect(messageOf(validator.validate(holding('value', branch), { value: {} }))).toBe(
            '$.value.id is required',
        );
    });

    it('accepts any key only where additionalProperties is EXPLICITLY true', () => {
        const open = new ApiJsonSchema('object');
        open.additionalProperties = true;
        const absent = new ApiJsonSchema('object');

        expect(validator.validate(open, { anything: { deep: [1] } })).toBeUndefined();
        // An ordinary DTO schema with NO additionalProperties stays strict (#1441).
        expect(messageOf(validator.validate(absent, { anything: 1 }))).toBe('$.anything is not allowed');
    });

    it('keeps a typed map typing every value beside the open JSON marker', () => {
        const map = new ApiJsonSchema('object');
        map.additionalProperties = new ApiJsonSchema('integer');
        const schema = new ObjectSchemaBuilder()
            .required('counts', map)
            .required('extra', openJson())
            .build();

        expect(validator.validate(schema, { counts: { a: 1 }, extra: { free: 'form' } })).toBeUndefined();
        expect(messageOf(validator.validate(schema, { counts: { a: 'one' }, extra: 1 }))).toBe(
            '$.counts.a must be a number',
        );
        expect(messageOf(validator.validate(schema, { counts: {}, extra: 1, surprise: true }))).toBe(
            '$.surprise is not allowed',
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
