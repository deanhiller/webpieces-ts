import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel, DocumentedEndpoint } from '../model/ApiDocModel';
import { McpRenderError } from '../render/McpRenderError';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';

/**
 * THE REPO SWEEP: every `@WpMcpTool` under `packages/**` and `apps/**`, rendered.
 *
 * `McpSchemaGolden.spec.ts` pins the exact bytes of ONE contract's catalog. This file asks the wider
 * question — *can the compiler render the schemas of the contracts this repo actually has?* — and
 * answers it for all of them at once.
 *
 * It was born (#983) carrying two more lists: a LIE DETECTOR comparing each `@WpDtoField` argument
 * against its field's declared type, and a MIGRATION list of every place `@WpMcpTool({description})`
 * and the source prose differed. Both measured a SECOND declaration, and #984 deleted it, so both
 * are gone with it: there is nothing left for a contract to lie to, and one source of prose cannot
 * disagree with itself.
 *
 * ## The blocked list is asserted, not merely recorded
 *
 * A tool the compiler cannot render is named with its reason, and the whole list is compared exactly.
 * A NEW blocked tool fails here, and so does a fixed one — the second direction is the point: a
 * contract quietly becoming publishable should be noticed by whoever made it so.
 *
 * ## Why a spec under a repo-agnostic package walks repo paths
 *
 * `responsibilities.md` keeps repo paths out of this package's `src`, and that constraint is about
 * the published SURFACE — `tsconfig.lib.json` excludes specs, so nothing here ships. The fact being
 * measured is a fact about THIS repo's contracts, so the measurement lives where the renderer does.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SWEPT_ROOTS = ['packages', 'apps'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.nx']);

/** ONE tool the sweep looked at, and whether the compiler could render its schemas. */
class ToolOutcome {
    constructor(
        readonly contract: string,
        readonly toolName: string,
        readonly blockedBy: string | undefined,
    ) {}

    toString(): string {
        return this.blockedBy === undefined
            ? `${this.contract}/${this.toolName}`
            : `${this.contract}/${this.toolName}: ${this.blockedBy}`;
    }
}

class Sweep {
    readonly tools: ToolOutcome[] = [];
    readonly files: string[] = [];

    run(): void {
        const found = Sweep.filesDeclaringTools();
        this.files.push(...found.map((file: string) => path.relative(REPO_ROOT, file)));
        const program = ts.createProgram(found, Sweep.compilerOptions());
        const extractor = new ApiDocExtractor();
        for (const file of found) {
            const source = program.getSourceFile(file);
            if (source === undefined) {
                throw new Error(`swept file is not in the program: ${file}`);
            }
            for (const model of extractor.extractAllFrom(program, source)) {
                this.sweepContract(model);
            }
        }
    }

    /** Every tool of one contract, and whether its schemas render. */
    private sweepContract(model: ApiDocModel): void {
        for (const endpoint of model.endpoints) {
            if (endpoint.mcpTool === undefined) {
                continue;
            }
            this.tools.push(
                new ToolOutcome(
                    model.contractName,
                    endpoint.mcpTool.name,
                    Sweep.renderFailure(model, endpoint),
                ),
            );
        }
    }

    /**
     * Render ONE tool, by handing the renderer a model holding that endpoint alone.
     *
     * Per-TOOL and not per-contract because the report has to name the tool that cannot be published;
     * a contract-level catch would blame all seven of `McpRemoteFixtures`' tools for one of them.
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static renderFailure(
        model: ApiDocModel,
        endpoint: DocumentedEndpoint,
    ): string | undefined {
        const single = new ApiDocModel(
            model.contractName,
            model.apiTypes,
            model.basePath,
            model.description,
            [endpoint],
            model.types,
            model.unmapped,
        );
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the measurement
        try {
            new McpSchemaRenderer(single).render();
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            return err instanceof McpRenderError ? err.message : String(err);
        }
    }

    /** Every `.ts` under the swept roots whose text names `@WpMcpTool(`. */
    // webpieces-disable no-function-outside-class -- private static collector of this class
    private static filesDeclaringTools(): string[] {
        const found: string[] = [];
        for (const root of SWEPT_ROOTS) {
            Sweep.walk(path.join(REPO_ROOT, root), found);
        }
        return found.sort();
    }

    // webpieces-disable no-function-outside-class -- private static collector of this class
    private static walk(directory: string, found: string[]): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRECTORIES.has(entry.name)) {
                    Sweep.walk(full, found);
                }
                continue;
            }
            // A `.spec.ts` is skipped on purpose: `api-type.spec.ts` declares contracts that
            // deliberately BREAK the MCP biconditional in order to assert that the assert fires, and
            // a negative fixture is not a contract this repo publishes.
            if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
                continue;
            }
            const text = fs.readFileSync(full, 'utf8');
            // BOTH markers, and `@ApiPath` only at COLUMN ZERO: this package's own docstrings show
            // `@ApiPath('/stores')` inside a ` * ` comment, and a file that only TALKS about a
            // contract declares none. An indented match would put five docstrings in the inventory.
            if (text.includes('@WpMcpTool(') && /^@ApiPath\(/m.test(text)) {
                found.push(full);
            }
        }
    }

    /** `tsconfig.base.json`'s `paths`, so an `@webpieces/*` import in a swept file RESOLVES. */
    // webpieces-disable no-function-outside-class -- private static configuration of this class
    private static compilerOptions(): ts.CompilerOptions {
        const base = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, REPO_ROOT);
        return { ...parsed.options, noEmit: true, skipLibCheck: true, types: [] };
    }
}

describe('every @WpMcpTool in this repo, read by the compiler', () => {
    const sweep = new Sweep();

    beforeAll(() => {
        sweep.run();
    }, 120_000);

    it('finds every contract file that declares MCP tools', () => {
        expect(sweep.files).toEqual([
            'apps/app-example/partner-api/src/PartnerOrdersApi.ts',
            'packages/docs/api-doc-model/src/__tests__/fixtures/ExampleApi.ts',
            'packages/docs/api-doc-model/src/__tests__/fixtures/McpEnumApi.ts',
            'packages/docs/api-doc-model/src/__tests__/fixtures/McpEquivalenceApi.ts',
            'packages/docs/api-doc-model/src/__tests__/fixtures/McpUnionApi.ts',
            'packages/docs/openapi-generator/src/__tests__/fixtures/WidgetsApi.ts',
            'packages/http/mcp-server/src/__tests__/McpRemoteFixtures.ts',
            'packages/http/mcp-server/src/__tests__/WpMcpServerTestFixtures.ts',
        ]);
    });

    it('records which tools the compiler can render, and why the rest cannot', () => {
        expect(sweep.tools.map(String)).toEqual([
            // RENDERS since #1009. `Order.window` is a discriminated union, which this list used to
            // record as unpublishable — "MCP's input schema is one flat object with no oneOf". That
            // was never a protocol limit: MCP tool schemas are JSON Schema 2020-12, the same dialect
            // OpenAPI 3.1 uses, and the obstacle was our own `ApiJsonSchema` subset. The union is
            // NESTED, inside a property, which is the half that is legal — a union at the ROOT of a
            // tool schema is refused, here and by the `no-root-union-api-type` build rule.
            'PartnerOrdersApi/fetch_orders',
            // A RECURSIVE DTO: `TreeNode` holds `TreeNode[]`. A tool schema is inline and has no
            // `$ref` to close a loop with, so there is no shape to publish. The same fixture also
            // carries `Mixed`, an un-narrowable union, for the reason above.
            "ExampleApi/save_customer: recursive DTO 'TreeNode' cannot use an inline MCP schema (TreeNode)",
            // String enums in every position, and discriminators spelled with enum members and with a
            // union of values on one branch (#1023).
            'McpEnumApi/write_story',
            // Two branches claiming one discriminator value: TypeScript cannot narrow it, so there is
            // no discriminator to derive and no schema to publish.
            "McpEnumApi/overlap_story: no MCP schema for the declared type 'OverlapA | OverlapB' (OverlapRequest.choice)",
            'McpEquivalenceApi/lookup_orders',
            'McpEquivalenceApi/cancel_order',
            'McpEquivalenceApi/reindex_store',
            'McpUnionApi/fetch_delivery',
            // A ROOT-level union request. Legal TypeScript, legal HTTP, and unservable as a tool:
            // the OpenAI and Anthropic function-calling APIs reject a top-level oneOf, and a server
            // sends its whole tool list on every request, so one of these 400s the whole session.
            "McpUnionApi/move_window: an MCP tool's request is itself a union (McpUnionApi.moveWindow)",
            'WidgetsApi/list_widgets',
            'RemoteMcpApi/remote_integration_search',
            'MissingRemoteMcpApi/missing_remote_integration_search',
            'RefusedRemoteApi/refused_remote',
            'GarbageRemoteApi/garbage_remote',
            'OidcFailRemoteApi/oidc_fail_remote',
            'LocalThrowApi/local_throw',
            'RemoteThrowApi/remote_throw',
            'SearchApi/account_search',
            'SearchApi/admin_search',
            'RemoteSearchApi/remote_search',
        ]);
    });

    it('names every tool under the stable protocol name @WpMcpTool declares', () => {
        expect(sweep.tools.every((tool: ToolOutcome) => tool.toolName.trim() !== '')).toBe(true);
    });
});
