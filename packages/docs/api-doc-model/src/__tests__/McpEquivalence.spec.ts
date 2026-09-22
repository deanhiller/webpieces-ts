import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
    ApiJsonSchema,
    DtoSchemaBuilder,
    getEndpointOperation,
    getWpMcpTools,
    mcpHintsForOperation,
    WpMcpToolHints,
    WpMcpToolMetadata,
} from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel } from '../model/ApiDocModel';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';
import { McpToolDefinition } from '../render/McpToolDefinition';
import { McpEquivalenceApi } from './fixtures/McpEquivalenceApi';

/**
 * THE EQUIVALENCE GATE (#983). It answers one question with a measurement rather than an argument:
 *
 * > does the TypeScript compiler, reading the contract source, produce the SAME MCP schema that the
 * > running `DtoSchemaBuilder` produces from reflect-metadata?
 *
 * #984 deletes every erasure-repair argument of `@WpDtoField` — `required`, `arrayItems`, `integer`,
 * `minimum`, `maximum`, `enumValues` — and takes the MCP runtime off reflection. If the two readers
 * disagree about one field, the tool published to agents quietly loses a `required` entry or an
 * `enum`, and that fails an agent CALL at runtime, not a BUILD. So this spec exists to make the
 * disagreement, if there is one, fail here instead.
 *
 * ## The comparison is never relaxed to make a test pass
 *
 * A mismatch is one of exactly two things and both are real defects: an extractor bug, or a
 * `@WpDtoField` argument that LIES about the TypeScript type (`required: true` on a `?` field,
 * `arrayItems: 'string'` on a `number[]`). Loosening the assertion would destroy the only value this
 * file has, so every difference is fixed at the CONTRACT.
 *
 * ## `description` is the ONE field compared as a MIGRATION list rather than an equality
 *
 * The settled design gives documentation one source, JSDoc, and #984 deletes `@WpMcpTool`'s
 * `description`. TODAY both exist, so where they differ that is a migration item and not a failure —
 * see `McpRepoSweep.spec.ts`, which enumerates every one of them across the repo. THIS fixture is
 * written with the two byte-identical, because it is what a contract looks like the moment before the
 * decorator's copy is deleted, so here the equality is asserted.
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

/** ONE disagreement between the two readers, at one JSON-pointer-ish path. */
class SchemaDifference {
    constructor(
        readonly where: string,
        readonly compiler: string,
        readonly runtime: string,
    ) {}

    toString(): string {
        return `${this.where}: compiler=${this.compiler} runtime=${this.runtime}`;
    }
}

/**
 * The runtime half of ONE tool, built the way `McpToolRegistry` builds it — the same
 * `DtoSchemaBuilder`, the same `mcpHintsForOperation`, the same metadata readers.
 *
 * It is rebuilt here rather than imported from `@webpieces/mcp-server` for a reason worth stating:
 * this package depends on `typescript`, and a docs package that pulled the MCP SERVER in would put a
 * compiler in the dependency closure of every app that runs one. The three calls below ARE the
 * registry's schema path; anything the registry adds on top (auth, bindings, name uniqueness) is not
 * schema and is not what this gate measures.
 */
class RuntimeTool {
    constructor(
        readonly name: string,
        readonly methodName: string,
        readonly description: string,
        readonly hints: WpMcpToolHints,
        readonly inputSchema: ApiJsonSchema,
        readonly outputSchema: ApiJsonSchema,
    ) {}
}

class Harness {
    private readonly builder = new DtoSchemaBuilder();

    model(): ApiDocModel {
        const fixture = path.join(__dirname, 'fixtures', 'McpEquivalenceApi.ts');
        return new ApiDocExtractor().extractFile(fixture, COMPILER_OPTIONS);
    }

    compilerTools(): readonly McpToolDefinition[] {
        return new McpSchemaRenderer(this.model()).render();
    }

    runtimeTools(): readonly RuntimeTool[] {
        return getWpMcpTools(McpEquivalenceApi).map((meta: WpMcpToolMetadata) => {
            const operation = getEndpointOperation(McpEquivalenceApi, meta.methodName);
            return new RuntimeTool(
                meta.name,
                meta.methodName,
                meta.description,
                mcpHintsForOperation(operation, meta.openWorldHint),
                this.builder.build(this.builder.requestClassOf(McpEquivalenceApi, meta.methodName)),
                this.builder.build(
                    this.builder.responseClassOf(McpEquivalenceApi, meta.methodName),
                ),
            );
        });
    }

    /**
     * Every difference between two schemas, with the PATH of each one.
     *
     * A hand-written walk and not `expect(a).toEqual(b)` because the failure message is the product:
     * "`lookup_orders.inputSchema.properties.limit.type`: compiler=number runtime=integer" names the
     * field, the side that disagrees and the value, which is what somebody fixing the contract needs.
     * A structural diff of two 200-line schemas names none of those.
     */
    differences(compiler: unknown, runtime: unknown, where: string): SchemaDifference[] {
        if (Harness.isLeaf(compiler) || Harness.isLeaf(runtime)) {
            return Harness.leafDifference(compiler, runtime, where);
        }
        const found: SchemaDifference[] = [];
        const keys = new Set<string>([
            ...Object.keys(compiler as object),
            ...Object.keys(runtime as object),
        ]);
        for (const key of Array.from(keys).sort()) {
            found.push(
                ...this.differences(
                    (compiler as Record<string, unknown>)[key],
                    (runtime as Record<string, unknown>)[key],
                    `${where}.${key}`,
                ),
            );
        }
        return found;
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static isLeaf(value: unknown): boolean {
        return value === null || typeof value !== 'object';
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static leafDifference(
        compiler: unknown,
        runtime: unknown,
        where: string,
    ): SchemaDifference[] {
        const left = JSON.stringify(compiler) ?? 'absent';
        const right = JSON.stringify(runtime) ?? 'absent';
        return left === right ? [] : [new SchemaDifference(where, left, right)];
    }
}

describe('MCP schema equivalence: compiler vs running DtoSchemaBuilder', () => {
    const harness = new Harness();
    let compilerTools: readonly McpToolDefinition[];
    let runtimeTools: readonly RuntimeTool[];

    beforeAll(() => {
        compilerTools = harness.compilerTools();
        runtimeTools = harness.runtimeTools();
    });

    it('finds the same tools, by protocol name', () => {
        const compilerNames = compilerTools.map((tool: McpToolDefinition) => tool.name).sort();
        const runtimeNames = runtimeTools.map((tool: RuntimeTool) => tool.name).sort();
        expect(compilerNames).toEqual(runtimeNames);
        expect(compilerNames).toEqual(['cancel_order', 'lookup_orders', 'reindex_store']);
    });

    it('binds each protocol name to the same contract method', () => {
        for (const tool of compilerTools) {
            const runtime = runtimeTools.find((each: RuntimeTool) => each.name === tool.name)!;
            expect(tool.methodName).toBe(runtime.methodName);
        }
    });

    /**
     * All four hints, for all three `EndpointOperation` values. Three of them are COMPUTED from
     * `operation` by the one shared `mcpHintsForOperation`, so this is really asserting that both
     * readers arrive at the same OPERATION — and, for `openWorldHint`, that `@Endpoint`'s `openWorld`
     * option says what `@WpMcpTool`'s soon-to-be-deleted `openWorldHint` argument says.
     */
    it('computes identical hints, including openWorldHint from @Endpoint options', () => {
        for (const tool of compilerTools) {
            const runtime = runtimeTools.find((each: RuntimeTool) => each.name === tool.name)!;
            const differences = harness.differences(
                tool.hints,
                runtime.hints,
                `${tool.name}.hints`,
            );
            expect(differences.map(String)).toEqual([]);
        }
    });

    it('renders identical input schemas for every tool', () => {
        for (const tool of compilerTools) {
            const runtime = runtimeTools.find((each: RuntimeTool) => each.name === tool.name)!;
            const differences = harness.differences(
                tool.inputSchema,
                runtime.inputSchema,
                `${tool.name}.inputSchema`,
            );
            expect(differences.map(String)).toEqual([]);
        }
    });

    it('renders identical output schemas for every tool', () => {
        for (const tool of compilerTools) {
            const runtime = runtimeTools.find((each: RuntimeTool) => each.name === tool.name)!;
            const differences = harness.differences(
                tool.outputSchema,
                runtime.outputSchema,
                `${tool.name}.outputSchema`,
            );
            expect(differences.map(String)).toEqual([]);
        }
    });

    it('carries the same description, which is what #984 deletes the decorator copy of', () => {
        for (const tool of compilerTools) {
            const runtime = runtimeTools.find((each: RuntimeTool) => each.name === tool.name)!;
            expect(tool.description).toBe(runtime.description);
        }
    });

    /**
     * The schema features the DTO fixture is there to exercise, asserted BY NAME.
     *
     * Without this, a fixture that quietly stopped covering `x-mcp-header` or `enum` would leave the
     * equality tests above green while measuring nothing — the two readers agree perfectly about a
     * field that is not there. The list is the erasure-repair arguments #984 deletes, one each.
     */
    it('covers every erasure-repair argument #984 deletes', () => {
        const lookup = compilerTools.find(
            (tool: McpToolDefinition) => tool.name === 'lookup_orders',
        )!;
        const properties = lookup.inputSchema.properties!;
        // `required` — TypeScript erases `?`
        expect(lookup.inputSchema.required).toEqual(['storeId']);
        // `arrayItems` — TypeScript erases an array's element type
        expect(properties.tags!.items!.type).toBe('string');
        expect(properties.orderNumbers!.items!.type).toBe('integer');
        // `integer` — a reflected Number is otherwise `number`
        expect(properties.limit!.type).toBe('integer');
        // `minimum` / `maximum`
        expect(properties.limit!.minimum).toBe(1);
        expect(properties.limit!.maximum).toBe(100);
        // `enumValues`
        expect(properties.phase!.enum).toEqual(['placed', 'done']);
        // `mapValues` — a Record reflects as plain Object
        expect(properties.filters!.additionalProperties).toEqual(new ApiJsonSchema('string'));
        expect((properties.labels!.additionalProperties as ApiJsonSchema).type).toBe('object');
        // a nested DTO, inlined and carrying the FIELD's prose
        expect(properties.page!.description).toBe('Where in the listing to resume.');
        expect(properties.page!.required).toEqual(['cursor', 'size']);
        // `mcpHeader` — declared in JSDoc as `@mcpHeader`, not in a decorator argument
        expect(properties.storeId!['x-mcp-header']).toBe('store-id');
    });
});
