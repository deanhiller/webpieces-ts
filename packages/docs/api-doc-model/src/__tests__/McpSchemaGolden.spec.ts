import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiJsonSchema, McpToolCatalog, McpToolDefinition } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';

/**
 * THE MCP SCHEMA REGRESSION GATE.
 *
 * It is what #983's equivalence gate BECAME. That spec answered a one-off question with a
 * measurement — does the compiler reading the source produce the same `ApiJsonSchema` the running
 * `DtoSchemaBuilder` produced from reflect-metadata? It does, for every DTO shape the runtime could
 * build, which is what licensed #984 to delete the runtime half. With one reader left there is
 * nothing to compare against, so the question changes to the one that matters from here on:
 *
 * > has anything moved a live tool's published schema?
 *
 * The answer is a COMMITTED golden file. `McpToolRegistry` reads exactly these bytes at boot and
 * agents are shown exactly this `tools/list`, so a diff here is a diff in a live protocol surface and
 * a human reads it in the PR that caused it. That is the same review device
 * `full-private-openapi.json` is, for the same reason.
 *
 * Regenerate deliberately, never reflexively: `UPDATE_MCP_GOLDEN=1 pnpm exec vitest run <this file>`.
 */
const CORE_UTIL = path.resolve(__dirname, '..', '..', '..', '..', 'core', 'core-util');
const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: CORE_UTIL,
    paths: { '@webpieces/core-util': [path.join(CORE_UTIL, 'src', 'index.ts')] },
};

const GOLDEN = path.join(__dirname, 'goldens', 'mcp-tools.json');

function renderCatalog(): McpToolCatalog {
    const fixture = path.join(__dirname, 'fixtures', 'McpEquivalenceApi.ts');
    const rendered = McpSchemaRenderer.catalogOf([
        new ApiDocExtractor().extractFile(fixture, COMPILER_OPTIONS),
    ]);
    expect(rendered.skipped).toEqual([]);
    return rendered.catalog;
}

describe('the MCP tool catalog rendered from a contract', () => {
    let catalog: McpToolCatalog;

    beforeAll(() => {
        catalog = renderCatalog();
        if (process.env['UPDATE_MCP_GOLDEN']) {
            fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
            fs.writeFileSync(GOLDEN, catalog.toJsonText(), 'utf8');
        }
    }, 60_000);

    it('matches the committed golden byte for byte', () => {
        expect(catalog.toJsonText()).toEqual(fs.readFileSync(GOLDEN, 'utf8'));
    });

    it('publishes every @WpMcpTool of the contract under its stable protocol name', () => {
        expect(catalog.names()).toEqual(['cancel_order', 'lookup_orders', 'reindex_store']);
    });

    /**
     * The four facts the deleted reflect-metadata runtime could not carry. Asserted here as well as
     * in the golden, because a golden says WHAT the bytes are and these say WHY they are worth
     * looking at — a regenerated golden that silently lost one of them would still be "a diff".
     */
    it('renders a NAMED TYPE ALIAS, which was transpiler-dependent at runtime', () => {
        const phase = lookupInput().properties?.['phase'];

        expect(phase?.type).toBe('string');
        expect(phase?.enum).toEqual(['placed', 'done']);
    });

    it('renders Integer — #981s preferred spelling — which no runtime DTO could use at all', () => {
        expect(lookupInput().properties?.['limit']?.type).toBe('integer');
        expect(lookupInput().properties?.['page']?.properties?.['size']?.type).toBe('integer');
    });

    it('renders NULLABLE as [T, "null"], which the runtime schema type could not express', () => {
        const external = lookupOutput().properties?.['orders']?.items?.properties?.['externalId'];

        expect(external?.type).toEqual(['string', 'null']);
        expect(ApiJsonSchema.allowsNull(external!)).toBe(true);
    });

    it('puts a bound on an ARRAY of numbers onto the ITEM, where the runtime had nowhere to put it', () => {
        expect(lookupInput().properties?.['orderNumbers']?.items?.minimum).toBe(1);
    });

    it('carries @mcpHeader through as the x-mcp-header extension', () => {
        expect(lookupInput().properties?.['storeId']?.['x-mcp-header']).toBe('store-id');
    });

    it('takes every tool description from JSDoc, never from the decorator', () => {
        expect(tool('cancel_order').description).toBe('Cancels one order.');
        expect(tool('reindex_store').description).toBe("Rebuilds a store's menu cache.");
    });

    it('computes three hints from @Endpoint.operation and openWorldHint from its options', () => {
        expect(tool('lookup_orders').hints).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        expect(tool('cancel_order').hints).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
        });
        expect(tool('reindex_store').hints).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });
    });

    function tool(name: string): McpToolDefinition {
        const found = catalog.find(name);
        if (found === undefined) throw new Error(`no tool '${name}' in the rendered catalog`);
        return found;
    }

    function lookupInput(): ApiJsonSchema {
        return tool('lookup_orders').inputSchema;
    }

    function lookupOutput(): ApiJsonSchema {
        return tool('lookup_orders').outputSchema;
    }
});
