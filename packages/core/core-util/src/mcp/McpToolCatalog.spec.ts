import { describe, expect, it } from 'vitest';
import { ApiJsonSchema, ObjectSchemaBuilder } from './DtoSchema';
import { WpMcpToolHints } from './McpMetadata';
import { McpToolCatalog, McpToolCatalogError, McpToolDefinition } from './McpToolCatalog';

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

describe('McpToolCatalog', () => {
    it('round-trips through the generated artifact, rebuilding real class instances', () => {
        const source = new McpToolCatalog([tool('lookup_orders')]);

        const parsed = McpToolCatalog.fromJsonText(source.toJsonText());
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
        const parsed = McpToolCatalog.fromJsonText(new McpToolCatalog([tool('a')]).toJsonText());

        const nullable = parsed.find('a')?.inputSchema.properties?.['externalId'];
        expect(nullable?.type).toEqual(['string', 'null']);
        expect(ApiJsonSchema.allowsNull(nullable!)).toBe(true);
    });

    it('sorts the artifact by tool name so the generated file is diffable', () => {
        const text = new McpToolCatalog([tool('zebra'), tool('alpha')]).toJsonText();

        expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zebra"'));
    });

    it('REFUSES two tools sharing one protocol name', () => {
        expect(() => new McpToolCatalog([tool('same'), tool('same')])).toThrow(McpToolCatalogError);
    });

    it('REFUSES a catalog that is not an array of tool definitions, naming the cure', () => {
        expect(() => McpToolCatalog.fromJsonText('{}')).toThrow(/wp-openapi --manifest/);
        expect(() => McpToolCatalog.fromJsonText('[{"name":"a"}]')).toThrow(
            /is missing a tool definition hints block/,
        );
    });
});
