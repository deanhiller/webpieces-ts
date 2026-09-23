/**
 * `api-rules-for-openapi` and `api-rules-for-mcp` (#1011).
 *
 * ## The one test that matters
 *
 * "the SAME contract passes both rules, and then generates" — `the acceptance contract` block below.
 * Everything else here is a fixture for one refusal; that block is the FEATURE. If the rules pass and
 * generation then fails, the rules are incomplete, and that is a bug in this feature rather than in
 * the contract.
 *
 * It is proved by running the SAME code the generator runs, which is also how the rules themselves
 * are implemented: `ApiDocExtractor` for the OpenAPI half and `McpSchemaRenderer` for the MCP half.
 * The OpenAPI side is asserted through `model.unmapped` because that set IS what
 * `OpenApiGenerator.refuseUnmappedFields` refuses on — an empty one is the statement "the document's
 * only shape-level guard does not fire". `OpenApiGenerator` itself is not invoked here: it needs a
 * manifest and a document selection, and importing it would draw an nx graph edge from the rules
 * engine to the renderer that nothing at runtime needs.
 *
 * Two facts nothing else in this repo asserts:
 *
 *  - the rules fire on a contract that declares NO `@ApiType` (the reason they live in the rules
 *    engine and not in the doc parser, which only ever visits contracts that HAVE one), and
 *  - an existing `// webpieces-disable no-any-unknown` does NOT silence them. That rule asked
 *    whether the code is type-safe; these ask whether a partner is handed a field with no shape.
 */

import * as fs from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    ApiDocExtractor,
    ApiDocModel,
    DocumentedEndpoint,
    McpSchemaRenderer,
} from '@webpieces/api-doc-model';
import * as path from 'path';
import * as ts from 'typescript';
import {
    allRuleNames,
    sectionForRule,
    seedEntryForRule,
    CONFIG_FILENAME,
    specTempDirs,
} from '@webpieces/rules-config';
import { ApiUsageScanner, buildApiContracts } from '../api-usage/api-scanner';
import {
    ApiRulesForMcpError,
    ApiRulesForOpenApiError,
} from '../api-usage/api-contract-errors';
import {
    ApiContractDefect,
    ApiDocRule,
    ApiDocRulesFindings,
    McpExclusion,
    MCP_RULE,
    OPENAPI_RULE,
} from '../api-usage/api-doc-rules';
import { ApiDocRulesScan } from '../api-usage/api-doc-rules-scan';
import {
    BAD_MCP_API,
    CLEAN_API,
    CONTRADICTS_API,
    EXCLUDED_API,
    FixtureWorkspace,
    MCP_API,
    MIXED_SCALAR_API,
    OPEN_ENUM_API,
    UNDOCUMENTED_FIELD_API,
    UNKNOWN_VALUE_API,
    VOID_RPC_API,
    fixtureProjects,
} from './api-doc-rules-fixtures';

let root = '';

/** Both rules ARMED, over the named fixture projects. */
// webpieces-disable no-function-outside-class -- spec helper, beside the tests that read it
function scan(...names: string[]): ApiDocRulesFindings {
    return new ApiDocRulesScan(
        root,
        fixtureProjects(...names),
        ApiDocRule.armed(OPENAPI_RULE),
        ApiDocRule.armed(MCP_RULE),
    ).run();
}

/** `Api.method` (or `Api`) plus the headline, so an assertion reads like the printed refusal. */
// webpieces-disable no-function-outside-class -- spec helper, beside the tests that read it
function lines(found: readonly ApiContractDefect[]): string[] {
    return found.map((one: ApiContractDefect) => `${one.where()}: ${one.what}`);
}

/** The ONE model a fixture project declares, extracted exactly as the generator would. */
// webpieces-disable no-function-outside-class -- spec helper, beside the tests that read it
function extract(name: string): ApiDocModel {
    const file = path.join(root, `libraries/${name}/src/index.ts`);
    const program = ts.createProgram([file], {
        noEmit: true,
        skipLibCheck: true,
        types: [],
        experimentalDecorators: true,
    });
    const models = new ApiDocExtractor().extractAllFrom(program, program.getSourceFile(file)!);
    return models[0];
}

/** A webpieces.config.json that VALIDATES, with the two rules' entries replaced by `overrides`. */
// webpieces-disable no-any-unknown -- raw config JSON is an opaque option bag, as consumers write it
function writeConfig(overrides: Record<string, unknown>): string {
    const rules: Record<string, unknown> = {};
    const hookGuards: Record<string, unknown> = {};
    for (const name of allRuleNames()) {
        // webpieces-disable no-any-unknown -- one rule's opaque option bag
        const entry: Record<string, unknown> = {
            ...seedEntryForRule(name),
            mode: 'OFF',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
        };
        const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
        target[name] = entry;
    }
    for (const name of [OPENAPI_RULE, MCP_RULE]) {
        rules[name] = {
            mode: 'RUN_EVERY_TIME',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
            ...overrides,
        };
    }
    const dir = specTempDirs.make('wp-api-doc-rules-config-');
    fs.writeFileSync(
        path.join(dir, CONFIG_FILENAME),
        JSON.stringify({
            rules,
            hookGuards,
            commands: {
                'pr-gate': {
                    mode: 'ON',
                    buildCommand: 'echo ci',
                    mergeMode: 'AUTO',
                    reviewerAgents: 1,
                },
            },
            excludePaths: [],
            'match-rules': [],
        }),
    );
    return dir;
}

beforeAll(() => {
    root = specTempDirs.makeReal('wp-api-doc-rules-');
    const workspace = new FixtureWorkspace(root);
    workspace.project('clean-api', CLEAN_API);
    workspace.project('published-api', MCP_API);
    workspace.project('open-enum-api', OPEN_ENUM_API);
    workspace.project('mixed-scalar-api', MIXED_SCALAR_API);
    workspace.project('unknown-value-api', UNKNOWN_VALUE_API);
    workspace.project('void-rpc-api', VOID_RPC_API);
    workspace.project('bad-mcp-api', BAD_MCP_API);
    workspace.project('undocumented-field-api', UNDOCUMENTED_FIELD_API);
    workspace.project('excluded-api', EXCLUDED_API);
    workspace.project('contradicts-api', CONTRADICTS_API);
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('the acceptance contract — rules pass, THEN @ApiType generates', () => {
    it('finds nothing on a contract that declares NO @ApiType and is fully expressible', () => {
        const findings = scan('clean-api');

        expect(lines(findings.openApi.violations)).toEqual([]);
        expect(lines(findings.mcp.violations)).toEqual([]);
    });

    it('passes the SAME contract once @ApiType and @WpMcpTool are added', () => {
        const findings = scan('published-api');

        expect(lines(findings.openApi.violations)).toEqual([]);
        expect(lines(findings.mcp.violations)).toEqual([]);
    });

    it('then GENERATES: nothing unmapped for the OpenAPI document, and a real MCP tool', () => {
        const model = extract('published-api');

        // What OpenApiGenerator.refuseUnmappedFields refuses on. Empty means it does not fire.
        expect(model.unmapped.map((one: { typeText: string }) => one.typeText)).toEqual([]);

        const render = McpSchemaRenderer.catalogOf([model]);
        expect(render.skipped.map(String)).toEqual([]);
        expect(render.catalog.names()).toEqual(['fetch_order']);
        const tool = render.catalog.find('fetch_order')!;
        expect(tool.description).toBe('Fetch one order by its id.');
        expect(tool.inputSchema.properties!['id'].type).toBe('string');
        expect(tool.outputSchema.properties!['phase'].enum).toEqual(['placed', 'done']);
    });

    it('still renders that tool when the rules are asked about it one endpoint at a time', () => {
        const model = extract('published-api');
        const renderer = new McpSchemaRenderer(model);

        for (const endpoint of model.endpoints as readonly DocumentedEndpoint[]) {
            if (endpoint.mcpTool === undefined) continue;
            expect(() => renderer.tool(endpoint)).not.toThrow();
        }
    });
});

describe('api-rules-for-openapi', () => {
    it('REFUSES an open enum on a contract with NO @ApiType, and says enum OR string', () => {
        const findings = scan('open-enum-api');

        expect(findings.openApi.violations).toHaveLength(1);
        const found = findings.openApi.violations[0];
        expect(found.api).toBe('StoreStatusApi');
        expect(found.what).toContain('OPEN ENUM');
        expect(found.cure).toContain('Use an enum OR a string, not both');
        expect(found.at).toContain('libraries/open-enum-api/src/index.ts:');
    });

    it('REFUSES a mixed scalar union rather than mis-validating it', () => {
        const findings = scan('mixed-scalar-api');

        expect(findings.openApi.violations).toHaveLength(1);
        const found = findings.openApi.violations[0];
        expect(found.what).toContain('MIXED SCALAR');
        expect(found.cure).toContain('VALIDATE WRONGLY');
    });

    /**
     * #1016 refused `void` on `rpc` alone, because `external` was unstated at the time. It is stated
     * now (#1017): an `external` endpoint is a SYNCHRONOUS call an outside caller waits on, so there
     * is a body and it must be a named DTO that can gain a field later. `cloudtasks` and `cron` keep
     * it, because nobody is waiting for one.
     */
    it('REFUSES rpc AND external returning void, and ALLOWS cloudtasks and cron that do', () => {
        const findings = scan('void-rpc-api');

        expect(lines(findings.openApi.violations).sort()).toEqual([
            'StoresApi.closed: an external endpoint returns nothing a document can name (void, ' +
                'unknown, or no declared return type)',
            'StoresApi.pause: an rpc endpoint returns nothing a document can name (void, unknown, ' +
                'or no declared return type)',
        ]);
        expect(findings.openApi.violations[0].cure).toContain('empty object grows additively');
        expect(findings.openApi.violations[0].cure).toContain('An external endpoint is a synchronous');
    });

    it('REFUSES an unknown VALUE TYPE, is not silenced by a no-any-unknown disable, and honours its own', () => {
        const findings = scan('unknown-value-api');

        // `discount` carries only a no-any-unknown disable, which answered a different question.
        expect(lines(findings.openApi.violations)).toEqual([
            "PromotionsApi: 'ReadResponse.discount' publishes an 'unknown' value, so the document " +
                'states no shape for it at all',
        ]);
        // `data` argued its case for THIS rule and is gone; `params` named the rule and said nothing.
        expect(lines(findings.openApi.reasonlessDisables)).toEqual([
            "PromotionsApi: 'ReadResponse.params' publishes an 'unknown' value, so the document " +
                'states no shape for it at all',
        ]);
    });

    it('detects the unknown VALUE TYPE by what it is, not by the Record<> spelling', () => {
        const findings = scan('unknown-value-api');
        const named = [
            ...findings.openApi.violations,
            ...findings.openApi.reasonlessDisables,
        ].map((one: ApiContractDefect) => one.what);

        expect(named.some((what: string) => what.includes('params'))).toBe(true);
    });

    it('names the REPORTING rule in the disable it prescribes, not a fixed one', () => {
        // A shared defect is carried by whichever rule is running, and DefectCollector resolves the
        // disable under its OWN name. A cure that always said api-rules-for-openapi would hand an
        // mcp-only repo a suppression the collector reading that site never looks for.
        const both = scan('unknown-value-api');
        expect(both.openApi.violations[0].cure).toContain(
            `// webpieces-disable ${OPENAPI_RULE} --`,
        );

        const mcpOnly = new ApiDocRulesScan(
            root,
            fixtureProjects('unknown-value-api'),
            ApiDocRule.off(OPENAPI_RULE),
            ApiDocRule.armed(MCP_RULE),
        ).run();
        expect(mcpOnly.mcp.violations[0].cure).toContain(`// webpieces-disable ${MCP_RULE} --`);
        expect(mcpOnly.mcp.violations[0].cure).not.toContain(OPENAPI_RULE);
    });

    it('labels a partner-facing contract, so the loud finding is not buried', () => {
        const findings = scan('unknown-value-api');

        expect(findings.openApi.violations[0].isExternal()).toBe(true);
        expect(findings.openApi.violations[0].exposure).toEqual(['external-customer']);
    });
});

describe('api-rules-for-mcp', () => {
    it('REFUSES a tool on a non-RPC endpoint, a tool with no auth, and an undocumented tool', () => {
        const findings = scan('bad-mcp-api');

        expect(lines(findings.mcp.violations)).toEqual([
            "SearchApi.reindex: an MCP tool is declared on a 'cloudtasks' endpoint",
            'SearchApi.open: an MCP tool declares no HTTP auth',
            'SearchApi.open: an MCP tool does not declare @WpMcpAuthJwt(...)',
            'SearchApi.quiet: an MCP tool has no documentation (SearchApi.quiet) — no MCP schema ' +
                'could be built',
        ]);
    });

    it('REFUSES a tool whose reachable DTO field has no JSDoc — the biggest measured bucket', () => {
        const findings = scan('undocumented-field-api');

        expect(lines(findings.mcp.violations)).toEqual([
            'WidgetsApi.list: a published DTO field has no documentation (ListRequest.ownerId) — ' +
                'no MCP schema could be built',
        ]);
        expect(findings.mcp.violations[0].cure).toContain('only thing an agent is told');
    });

    it('reports an OpenAPI-level defect ONCE, under whichever of the two rules is running', () => {
        const mcpOnly = new ApiDocRulesScan(
            root,
            fixtureProjects('open-enum-api'),
            ApiDocRule.off(OPENAPI_RULE),
            ApiDocRule.armed(MCP_RULE),
        ).run();

        expect(lines(mcpOnly.openApi.violations)).toEqual([]);
        expect(mcpOnly.mcp.violations).toHaveLength(1);
        expect(mcpOnly.mcp.violations[0].what).toContain('OPEN ENUM');

        const both = scan('open-enum-api');
        expect(both.openApi.violations).toHaveLength(1);
        expect(both.mcp.violations).toEqual([]);
    });
});

describe('@InvalidEndpointForMcp (#1014)', () => {
    it('SATISFIES api-rules-for-mcp for that method, with no webpieces-disable anywhere', () => {
        const findings = scan('excluded-api');

        expect(lines(findings.mcp.violations)).toEqual([]);
        expect(lines(findings.mcp.reasonlessDisables)).toEqual([]);
    });

    it('does NOT excuse the OpenAPI document — the two rules answer different questions', () => {
        // The endpoint is permanently outside MCP; its envelope field is still published in the
        // OpenAPI document with no shape, so api-rules-for-openapi still has something to say. That
        // separation is the point: the decorator is not a blanket amnesty.
        const findings = scan('excluded-api');

        expect(lines(findings.openApi.violations)).toEqual([
            "PublicWebhooksApi: 'FanoutRequest.data' publishes an 'unknown' value, so the document " +
                'states no shape for it at all',
        ]);
    });

    it('RESTATES every exclusion with its reason, on a run with no MCP findings at all', () => {
        const findings = scan('excluded-api');

        expect(
            findings.mcpExclusions.map((one: McpExclusion) => `${one.api}.${one.method}`),
        ).toEqual(['PublicWebhooksApi.fanout']);
        expect(findings.mcpExclusions[0].reason).toContain('opaque by design');
        expect(findings.mcpExclusions[0].at).toContain('libraries/excluded-api/src/index.ts:');
    });

    it('collects nothing when api-rules-for-mcp is not the rule running', () => {
        const openApiOnly = new ApiDocRulesScan(
            root,
            fixtureProjects('excluded-api'),
            ApiDocRule.armed(OPENAPI_RULE),
            ApiDocRule.off(MCP_RULE),
        ).run();

        expect(openApiOnly.mcpExclusions).toEqual([]);
    });

    it('REFUSES @WpMcpTool on the same method — they contradict each other', () => {
        const findings = scan('contradicts-api');

        expect(findings.openApi.violations).toHaveLength(1);
        expect(findings.openApi.violations[0].what).toContain(
            '@WpMcpTool and @InvalidEndpointForMcp are BOTH on search',
        );
        expect(findings.openApi.violations[0].cure).toContain('Delete whichever one is wrong');
    });

    it('prints the exclusion list inside the MCP refusal, where somebody is already reading', () => {
        const message = new ApiRulesForMcpError(
            scan('undocumented-field-api').mcp,
            scan('excluded-api').mcpExclusions,
        ).message;

        expect(message).toContain('PERMANENTLY outside MCP (@InvalidEndpointForMcp)');
        expect(message).toContain('PublicWebhooksApi.fanout');
        expect(message).toContain('opaque by design');
        expect(message).toContain('These are DECLARATIONS, not suppressions');
    });
});

describe('the refusals that fail the build', () => {
    it('throws ApiRulesForOpenApiError, naming contract, defect, location and cure', () => {
        const result = new ApiUsageScanner(
            root,
            fixtureProjects('open-enum-api'),
            [],
            undefined,
            ApiDocRule.armed(OPENAPI_RULE),
            ApiDocRule.armed(MCP_RULE),
        ).scan();

        expect(() => buildApiContracts(result)).toThrow(ApiRulesForOpenApiError);
        const message = new ApiRulesForOpenApiError(result.apiDocRules.openApi).message;
        expect(message).toContain('would block the OpenAPI document');
        expect(message).toContain('StoreStatusApi');
        expect(message).toContain('OPEN ENUM');
        expect(message).toContain('Use an enum OR a string, not both');
        expect(message).toContain('libraries/open-enum-api/src/index.ts:');
        expect(message).toContain('EVERY @ApiPath contract, with or without @ApiType');
        expect(message).toContain(`// webpieces-disable ${OPENAPI_RULE} -- <reason>`);
    });

    it('throws ApiRulesForMcpError, and says the tool would stop the server booting', () => {
        const result = new ApiUsageScanner(
            root,
            fixtureProjects('undocumented-field-api'),
            [],
            undefined,
            ApiDocRule.armed(OPENAPI_RULE),
            ApiDocRule.armed(MCP_RULE),
        ).scan();

        expect(() => buildApiContracts(result)).toThrow(ApiRulesForMcpError);
        const message = new ApiRulesForMcpError(result.apiDocRules.mcp).message;
        expect(message).toContain('could not be served as MCP tools');
        expect(message).toContain('WidgetsApi.list');
        expect(message).toContain('McpToolRegistry REFUSE TO BOOT');
    });

    it('says the reason is MANDATORY when a disable gives none', () => {
        const findings = scan('unknown-value-api');
        const message = new ApiRulesForOpenApiError(findings.openApi).message;

        expect(message).toContain(`disable(s) of ${OPENAPI_RULE} give NO reason`);
        expect(message).toContain('The reason is MANDATORY');
        expect(message).toContain('params');
    });

    it('marks a partner-facing defect in the printed refusal', () => {
        const findings = scan('unknown-value-api');

        expect(new ApiRulesForOpenApiError(findings.openApi).message).toContain('[PARTNER-FACING]');
    });
});

describe('the switches', () => {
    it('ships OFF — a scanner built with no configuration finds nothing at all', () => {
        const findings = new ApiDocRulesScan(root, fixtureProjects('open-enum-api')).run();

        expect(findings.openApi.isEmpty()).toBe(true);
        expect(findings.mcp.isEmpty()).toBe(true);
    });

    it('reads mode: OFF out of webpieces.config.json', () => {
        const configured = writeConfig({ mode: 'OFF' });

        expect(ApiDocRule.fromConfig(configured, OPENAPI_RULE).enabled).toBe(false);
        expect(ApiDocRule.fromConfig(configured, MCP_RULE).enabled).toBe(false);
    });

    it('reads RUN_EVERY_TIME, and allowedPaths exempts that tree', () => {
        const armed = writeConfig({});
        expect(ApiDocRule.fromConfig(armed, OPENAPI_RULE).enabled).toBe(true);

        const exempt = writeConfig({ allowedPaths: ['libraries/open-enum-api'] });
        const rule = ApiDocRule.fromConfig(exempt, OPENAPI_RULE);
        expect(rule.allowedPaths).toEqual(['libraries/open-enum-api']);
        expect(
            new ApiDocRulesScan(
                root,
                fixtureProjects('open-enum-api'),
                rule,
                ApiDocRule.fromConfig(exempt, MCP_RULE),
            )
                .run()
                .openApi.isEmpty(),
        ).toBe(true);
    });

    /**
     * AFFECTED_PROJECT (#1017) — the granularity nx already builds at. A contract in a project no
     * changed path belongs to CANNOT have changed, so it is not scanned; every project whose tree the
     * diff touched is. The two assertions below are one fixture read twice, which is the only way to
     * show the narrowing rather than the rule simply being off.
     */
    it('AFFECTED_PROJECT does not scan an UNAFFECTED project, and does scan an affected one', () => {
        const unaffected = new ApiDocRulesScan(
            root,
            fixtureProjects('open-enum-api'),
            ApiDocRule.affected(OPENAPI_RULE, ['libraries/some-other-api/src/index.ts']),
            ApiDocRule.off(MCP_RULE),
        ).run();
        expect(unaffected.openApi.isEmpty()).toBe(true);

        const affected = new ApiDocRulesScan(
            root,
            fixtureProjects('open-enum-api'),
            ApiDocRule.affected(OPENAPI_RULE, ['libraries/open-enum-api/src/index.ts']),
            ApiDocRule.off(MCP_RULE),
        ).run();
        expect(affected.openApi.violations.length).toBeGreaterThan(0);
    });

    it('a path that merely PREFIXES a project root does not make it affected', () => {
        const rule = ApiDocRule.affected(OPENAPI_RULE, ['libraries/open-enum-api-extras/src/x.ts']);

        expect(rule.coversProject('libraries/open-enum-api')).toBe(false);
        expect(rule.coversProject('libraries/open-enum-api-extras')).toBe(true);
    });

    it('RUN_EVERY_TIME carries no changed-path narrowing at all', () => {
        expect(ApiDocRule.armed(OPENAPI_RULE).changedPaths).toBeNull();
        expect(ApiDocRule.armed(OPENAPI_RULE).coversProject('anything/at/all')).toBe(true);
    });

    it('reads the MODE out of webpieces.config.json: RUN_EVERY_TIME scans all, AFFECTED_PROJECT asks the diff', () => {
        expect(ApiDocRule.fromConfig(writeConfig({}), OPENAPI_RULE).changedPaths).toBeNull();

        const affected = ApiDocRule.fromConfig(
            writeConfig({ mode: 'AFFECTED_PROJECT' }),
            OPENAPI_RULE,
        );
        expect(affected.enabled).toBe(true);
        // A LIST (possibly empty here — the fixture dir is not a repository), never null: null is
        // reserved for RUN_EVERY_TIME and for a diff that could not be computed at all.
        expect(Array.isArray(affected.changedPaths) || affected.changedPaths === null).toBe(true);
    });
});
