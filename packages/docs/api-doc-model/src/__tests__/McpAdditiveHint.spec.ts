import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { McpToolCatalogFile, McpToolDefinition, WpMcpToolHints } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';
import { OperationIds, OperationIdStyle } from '../model/OperationIds';

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

/**
 * `@Endpoint`'s `additive` option, from SOURCE to the generated catalog (#1422): the extractor reads
 * it off the decorator, and the renderer hands it to `mcpHintsForOperation`, so an additive write is
 * published `destructiveHint: false` with every other hint unchanged.
 */
describe('an additive write in the generated MCP catalog', () => {
    let catalog: McpToolCatalogFile;

    beforeAll(() => {
        const fixture = path.join(__dirname, 'fixtures', 'McpAdditiveApi.ts');
        const rendered = McpSchemaRenderer.catalogOf(
            [new ApiDocExtractor().extractFile(fixture, COMPILER_OPTIONS)],
            new OperationIds(OperationIdStyle.CONTRACT_METHOD),
        );
        expect(rendered.skipped).toEqual([]);
        catalog = rendered.catalogs[0]!;
    }, 60_000);

    function hints(name: string): WpMcpToolHints {
        const tool = catalog.tools.find((candidate: McpToolDefinition) => candidate.name === name);
        return tool!.hints;
    }

    it('publishes an additive WRITE as not destructive and not idempotent', () => {
        expect(hints('notes_add')).toEqual(new WpMcpToolHints(false, false, false, false));
    });

    it('publishes an additive WRITE_IDEMPOTENT as not destructive, idempotent, and keeps openWorld', () => {
        expect(hints('notes_save_draft')).toEqual(new WpMcpToolHints(false, false, true, true));
    });

    it('keeps a write that does not declare additive destructive', () => {
        expect(hints('notes_replace')).toEqual(new WpMcpToolHints(false, true, false, false));
    });
});
