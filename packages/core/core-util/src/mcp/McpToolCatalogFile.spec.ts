import { describe, expect, it } from 'vitest';
import { ApiJsonSchema, ObjectSchemaBuilder } from './DtoSchema';
import { WpMcpToolHints } from './McpMetadata';
import { McpToolCatalogError, McpToolCatalogFile, McpToolDefinition } from './McpToolCatalogFile';

function tool(name: string): McpToolDefinition {
    const input = new ObjectSchemaBuilder()
        .required('storeId', new ApiJsonSchema('string'))
        .optional('limit', new ApiJsonSchema('integer'))
        .optional('externalId', new ApiJsonSchema(['string', 'null']))
        .build();
    input.properties!['storeId']!['x-mcp-header'] = 'Store-Id';
    const output = new ObjectSchemaBuilder().required('ok', new ApiJsonSchema('boolean')).build();
    return new McpToolDefinition(
        name,
        'fetchOrders',
        'Read-only. Call this before answering.',
        new WpMcpToolHints(true, false, true, false),
        input,
        output,
    );
}

const FILE = 'mcp-OrdersApi-tools.json';

describe('McpToolCatalogFile', () => {
    it('round-trips through the generated artifact, rebuilding real class instances', () => {
        const source = new McpToolCatalogFile('OrdersApi', [tool('lookup_orders')]);

        const parsed = McpToolCatalogFile.fromJsonText(FILE, source.toJsonText());
        const found = parsed.find('lookup_orders');

        expect(found).toBeInstanceOf(McpToolDefinition);
        expect(found?.inputSchema).toBeInstanceOf(ApiJsonSchema);
        expect(found?.inputSchema.properties?.['limit']).toBeInstanceOf(ApiJsonSchema);
        expect(found?.inputSchema.required).toEqual(['storeId']);
        expect(found?.inputSchema.properties?.['storeId']?.['x-mcp-header']).toBe('Store-Id');
        expect(found?.hints).toBeInstanceOf(WpMcpToolHints);
        expect(found?.hints.readOnlyHint).toBe(true);
    });

    it('preserves a nullable type through the artifact', () => {
        const parsed = McpToolCatalogFile.fromJsonText(FILE, new McpToolCatalogFile('OrdersApi', [tool('a')]).toJsonText());

        const nullable = parsed.find('a')?.inputSchema.properties?.['externalId'];
        expect(nullable?.type).toEqual(['string', 'null']);
        expect(ApiJsonSchema.allowsNull(nullable!)).toBe(true);
    });

    it('sorts the artifact by tool name so the generated file is diffable', () => {
        const text = new McpToolCatalogFile('OrdersApi', [tool('zebra'), tool('alpha')]).toJsonText();

        expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zebra"'));
    });

    it('REFUSES two tools sharing one protocol name', () => {
        expect(() => new McpToolCatalogFile('OrdersApi', [tool('same'), tool('same')])).toThrow(McpToolCatalogError);
    });

    it('REFUSES a catalog that is not an array of tool definitions, naming the cure', () => {
        expect(() => McpToolCatalogFile.fromJsonText(FILE, '{}')).toThrow(/openapi-generate/);
        expect(() => McpToolCatalogFile.fromJsonText(FILE, '[{"name":"a"}]')).toThrow(
            /is missing a tool definition hints block/,
        );
    });

    it('names its file after the CONTRACT, and reads the contract back from the file name', () => {
        const file = new McpToolCatalogFile('LangCourseAuthorApi', [tool('a')]);

        expect(file.fileName).toBe('mcp-LangCourseAuthorApi-tools.json');
        expect(McpToolCatalogFile.contractNameOf('mcp-LangCourseAuthorApi-tools.json')).toBe(
            'LangCourseAuthorApi',
        );
        expect(McpToolCatalogFile.fromJsonText(file.fileName, file.toJsonText()).contractName).toBe(
            'LangCourseAuthorApi',
        );
    });

    it('is not fooled by the documents and the retired single-file name', () => {
        for (const name of ['mcp-tools.json', 'mcp-openapi.json', 'public-openapi.json', 'mcp-a-b-tools.json']) {
            expect(McpToolCatalogFile.contractNameOf(name), name).toBeUndefined();
        }
        expect(() => McpToolCatalogFile.fromJsonText('mcp-tools.json', '[]')).toThrow(
            /mcp-<ContractClass>-tools\.json/,
        );
    });
});
