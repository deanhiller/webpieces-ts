import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Validator } from '@seriousme/openapi-schema-validator';
import { ApiJsonSchema, ApiJsonSchemaValidator } from '@webpieces/core-util';
import { OpenApiCli } from '../cli/OpenApiCli';

/** A parsed JSON document, for assertions. */
type Json = Record<string, unknown>;

/** The open JSON schema `JsonValueDto` publishes, in every output. */
const OPEN_JSON = {
    type: ['string', 'number', 'boolean', 'object', 'array', 'null'],
    additionalProperties: true,
};

/**
 * #1447 — what a consumer previously patched into the installed packages, through the real CLI
 * against `fixtures/json/`:
 *
 * - `JsonValueDto` is the explicit recursive JSON marker: a field, a nullable field, an array item
 *   and a `Record` value all publish the open JSON schema, in the OpenAPI documents AND the MCP tool
 *   catalog, and the server-side validator accepts nested JSON through that schema while the DTO
 *   around it stays strict;
 * - `@InvalidEndpointForMcp` drops a method from `mcp-openapi.json` only — the private document
 *   still publishes it.
 */
class Run {
    readonly written = new Map<string, string>();

    constructor() {
        const fixtures = path.join(__dirname, 'fixtures');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-json-'));
        const result = new OpenApiCli().run(
            ['--manifest', path.join(fixtures, 'json', 'json.manifest.json'), '--out', out, '--format', 'json'],
            fixtures,
        );
        for (const file of result.written) {
            this.written.set(path.basename(file), fs.readFileSync(file, 'utf8'));
        }
    }

    document(fileName: string): Json {
        const text = this.written.get(fileName);
        expect(text, `nothing written at ${fileName}`).toBeDefined();
        return JSON.parse(text!) as Json;
    }

    /** `components.schemas.<name>.properties`, or the inline request body titled `<name>`. */
    properties(fileName: string, name: string): Json {
        const schemas = ((this.document(fileName)['components'] as Json)['schemas'] as Json | undefined) ?? {};
        const schema = (schemas[name] as Json | undefined) ?? this.inlineTitled(this.document(fileName)['paths'], name);
        expect(schema, `${fileName}: no schema ${name}`).toBeDefined();
        return schema!['properties'] as Json;
    }

    paths(fileName: string): string[] {
        return Object.keys(this.document(fileName)['paths'] as Json);
    }

    /** The save_settings tool's input schema, from the generated MCP catalog. */
    toolInput(): ApiJsonSchema {
        const tools = this.document('mcp-SettingsApi-tools.json') as unknown as Json[];
        expect(tools.map((each: Json) => each['name'])).toEqual(['save_settings']);
        const tool = tools.find((each: Json) => each['name'] === 'save_settings');
        expect(tool, 'no save_settings tool').toBeDefined();
        return tool!['inputSchema'] as ApiJsonSchema;
    }

    private inlineTitled(node: unknown, title: string): Json | undefined {
        if (typeof node !== 'object' || node === null) return undefined;
        const object = node as Json;
        if (object['title'] === title) return object;
        for (const value of Object.values(object)) {
            const found = this.inlineTitled(value, title);
            if (found !== undefined) return found;
        }
        return undefined;
    }
}

// webpieces-disable no-function-outside-class -- spec helper
async function validate(text: string): Promise<unknown> {
    const result = await new Validator().validate(JSON.parse(text) as object);
    return result.valid ? true : result.errors;
}

let run: Run;

beforeAll(() => {
    run = new Run();
}, 60_000);

describe('JsonValueDto — the recursive JSON marker (#1447)', () => {
    it('publishes the open JSON schema for a field, an array item, a Record value and a nullable field', () => {
        for (const fileName of ['full-private-openapi.json', 'mcp-openapi.json']) {
            const setting = run.properties(fileName, 'SettingDto');
            expect(setting['value'], fileName).toMatchObject(OPEN_JSON);
            expect((setting['choices'] as Json)['items'], fileName).toEqual(OPEN_JSON);
            // Already nullable: `null` is listed once, never collapsed to one member.
            expect(setting['previous'], fileName).toMatchObject(OPEN_JSON);
            expect((run.properties(fileName, 'SaveSettingsRequest')['byScope'] as Json)['additionalProperties'], fileName).toEqual(OPEN_JSON);
        }
    });

    it('publishes the same open schema in the MCP tool catalog', () => {
        const input = run.toolInput() as unknown as Json;
        const settings = (input['properties'] as Json)['settings'] as Json;
        const setting = (settings['items'] as Json)['properties'] as Json;
        expect(setting['value']).toMatchObject(OPEN_JSON);
        expect(setting['previous']).toMatchObject(OPEN_JSON);
        expect((setting['choices'] as Json)['items']).toEqual(OPEN_JSON);
    });

    it('lets the server validator accept nested JSON through the marker and keep the DTO strict', () => {
        const validator = new ApiJsonSchemaValidator();
        const input = run.toolInput();
        const nested = { theme: { colors: ['red', 2, null, { deep: [[true]] }] }, limit: 4 };
        const request = {
            settings: [{ key: 'ui', value: nested, previous: null, choices: [1, 'two', { three: 3 }] }],
            byScope: { story: nested, lesson: 'plain', none: null },
        };

        expect(validator.validate(input, request)).toBeUndefined();
        expect(validator.validate(input, { ...request, surprise: 1 })?.message).toBe('$.surprise is not allowed');
        const badKey = { settings: [{ key: 7, value: 1, previous: null }], byScope: {} };
        expect(validator.validate(input, badKey)?.message).toBe('$.settings[0].key must be a string');
    });

    it('writes documents that are valid OpenAPI 3.1', async () => {
        for (const fileName of ['full-private-openapi.json', 'mcp-openapi.json']) {
            expect(await validate(run.written.get(fileName)!), fileName).toBe(true);
        }
    });
});

describe('@InvalidEndpointForMcp in the generated documents (#1447)', () => {
    it('is absent from the MCP document and kept in the private one', () => {
        expect(run.paths('mcp-openapi.json')).toEqual(['/settings/save']);
        expect(run.paths('full-private-openapi.json').sort()).toEqual(['/settings/save', '/settings/upload']);
        expect(run.written.get('mcp-openapi.json')).not.toContain('ReadUpload');
    });
});
