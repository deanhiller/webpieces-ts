/**
 * `api-rules-for-openapi` and `api-rules-for-mcp` (#1011) — the CI half of "is this contract
 * publishable", on EVERY `@ApiPath` class in the workspace, `@ApiType` or not.
 *
 * ## The acceptance contract, and why this file drives the generator instead of copying it
 *
 * The rules exist so that ADDING `@ApiType(...)` (and `@WpMcpTool`) to a contract that passes them
 * always works. That is only true if "expressible" has exactly ONE definition, so this scan runs the
 * generator's own code — `ApiDocExtractor` / `TypeResolver` from `@webpieces/api-doc-model` for the
 * OpenAPI half, and `McpSchemaRenderer` tool-by-tool for the MCP half. A second implementation of
 * "what can be published" would drift from the first on the release that improved either one, and
 * the drift would be silent: the rules would stay green while generation started failing. The two
 * packages ship on the same release train, so the dependency is in lockstep by construction.
 *
 * Two things here are STRICTER than the generator, deliberately, and both are publishing rules
 * rather than expressibility ones (being stricter cannot break the acceptance contract — it can only
 * refuse something that would have generated):
 *
 *  - an `unknown` VALUE TYPE anywhere (`Record<string, unknown>`, `unknown[]`, a bare `unknown`
 *    field). The extractor maps it to a primitive and the generator publishes `{}`, which in JSON
 *    Schema means "anything" — a partner-facing field with no shape, which is the defect the
 *    unmapped guard exists for, arriving through a door the guard does not watch.
 *  - an RPC whose response is `void`. Fire-and-forget is the CONTRACT of a `cloudtasks` or `cron`
 *    endpoint and is allowed there; an RPC that answers nothing can never gain a field without a
 *    breaking change, where a named empty response object grows additively forever.
 *
 * ## Why it lives in the rules engine and not in the doc parser
 *
 * `@webpieces/api-doc-model` is only ever pointed at contracts somebody chose to publish. `@ApiType`
 * is a PUBLISHING decision added later, on purpose — so a shape rule that only ran on contracts which
 * had already opted in would let a team discover, six months afterwards, that the type was never
 * expressible, by which time it is in partners' generated clients. Every check below runs on every
 * contract in the workspace.
 *
 * ## Root-level unions are NOT re-checked here
 *
 * `no-root-union-api-type` (#1009) already refuses them, workspace-wide, with its own config key and
 * its own per-site hatch. One implementation. The MCP half still reports one when it meets it,
 * because `McpSchemaRenderer` refuses it as its own backstop and this scan reports whatever the
 * renderer says — which is the correct division: the OpenAPI document publishes a root union
 * perfectly well, and only a tool schema cannot carry one.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    ApiDocExtractionError,
    ApiDocExtractor,
    ApiDocModel,
    DocumentedEndpoint,
    McpRenderError,
    McpSchemaRenderer,
    TypeRef,
    UnmappedType,
} from '@webpieces/api-doc-model';
import { matchesAnyGlob } from '@webpieces/rules-config';
import { ProjectInfo } from '../project-info';
import { collectTsFiles, isTestFile } from './api-ast';
import {
    ApiContractDefect,
    ApiDocRule,
    ApiDocRulesFindings,
    ApiRuleFindings,
    DisableComment,
    McpExclusion,
    MCP_RULE,
    OPENAPI_RULE,
} from './api-doc-rules';
import {
    ContractLines,
    RPC_KIND,
    unknownValueCure,
    VOID_RPC_CURE,
    carriesUnknown,
    classifyUnmapped,
    contractLinesOf,
    contractNamesIn,
    isVoidLike,
    toolFailures,
} from './api-doc-rules-verdicts';

/** `@ApiPath(` at COLUMN ZERO — a docstring that TALKS about a contract declares none. */
const DECLARES_CONTRACT = /^@ApiPath\(/m;

/** ONE contract file, and which of the two rules apply to the project that owns it. */
class ContractFile {
    constructor(
        public readonly absPath: string,
        public readonly openApi: boolean,
        public readonly mcp: boolean,
    ) {}
}

/** Where one declaration sits, already split out of the extractor's `File.ts:LINE:COL` spelling. */
class Site {
    constructor(
        public readonly absPath: string,
        public readonly line: number,
    ) {}

    /** `path/to/File.ts:LINE`, workspace-relative — what a refusal prints. */
    relativeTo(workspaceRoot: string): string {
        return `${path.relative(workspaceRoot, this.absPath)}:${this.line}`;
    }

    /** `abs/File.ts:12:5` -> a Site. An unparseable one falls back to line 1 of `fallback`. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static parse(location: string, fallback: string): Site {
        const match = location.match(/^(.*):(\d+):\d+$/);
        if (match === null) return new Site(fallback, 1);
        return new Site(match[1], Number(match[2]));
    }
}

/**
 * ONE rule's accumulator. It is what applies the per-site disable, so the disable semantics live in
 * exactly one place and cannot differ between the two rules.
 */
class DefectCollector {
    private readonly violations: ApiContractDefect[] = [];
    private readonly reasonless: ApiContractDefect[] = [];

    constructor(private readonly ruleName: string) {}

    /** The rule this collector reports under — what a shared defect's cure has to name. */
    rule(): string {
        return this.ruleName;
    }

    add(defect: ApiContractDefect, site: Site): void {
        const disable = DisableComment.readAt(site.absPath, site.line, this.ruleName);
        if (disable === undefined) {
            this.violations.push(defect);
            return;
        }
        if (!disable.hasReason) this.reasonless.push(defect);
    }

    findings(): ApiRuleFindings {
        return new ApiRuleFindings(
            DefectCollector.externalFirst(this.violations),
            DefectCollector.externalFirst(this.reasonless),
        );
    }

    /**
     * Partner-facing contracts first. The same defect is a different size depending on who reads the
     * document it would have been in, and a list that buries the `external-customer` ones among
     * thirty internal ones has hidden the only urgent line in it.
     */
    // webpieces-disable no-function-outside-class -- private static ordering of this class
    private static externalFirst(found: readonly ApiContractDefect[]): ApiContractDefect[] {
        return [...found].sort(
            (a: ApiContractDefect, b: ApiContractDefect) =>
                Number(b.isExternal()) - Number(a.isExternal()),
        );
    }
}

/**
 * Routes a defect to the rule that owns it.
 *
 * Every OpenAPI-level defect ALSO blocks MCP, so it is reported by whichever rule is running —
 * `api-rules-for-openapi` when that one is on, and `api-rules-for-mcp` alone when it is not. It is
 * never reported twice: a team running both would otherwise read every shared defect in two places
 * and have to work out that they are one.
 */
class DefectSink {
    constructor(
        private readonly openApi: DefectCollector | undefined,
        private readonly mcp: DefectCollector | undefined,
    ) {}

    /**
     * A defect that blocks the OpenAPI document, and therefore every tool on it too.
     *
     * The defect is BUILT from the rule that ends up reporting it, not handed in ready-made, because
     * a shared defect does not know in advance which rule will carry it: `api-rules-for-openapi` when
     * that one runs, and `api-rules-for-mcp` alone when it does not. A cure that named a fixed rule
     * would, on the mcp-only configuration, prescribe a `// webpieces-disable` line the collector
     * reading that site does not look for.
     */
    shared(build: (rule: string) => ApiContractDefect, site: Site): void {
        const target = this.openApi ?? this.mcp;
        if (target === undefined) return;
        target.add(build(target.rule()), site);
    }

    /** A defect that blocks ONE tool and nothing else. */
    mcpOnly(defect: ApiContractDefect, site: Site): void {
        this.mcp?.add(defect, site);
    }

    anyRuleRuns(): boolean {
        return this.openApi !== undefined || this.mcp !== undefined;
    }

    /** True when `api-rules-for-mcp` applies to this file — what the exclusion list is scoped to. */
    mcpRuns(): boolean {
        return this.mcp !== undefined;
    }
}

/**
 * Walks every project's `src`, extracts every `@ApiPath` contract with the generator's own
 * extractor, and judges the result against the two rules.
 *
 * ONE `ts.Program` over every contract file in the workspace, because a DTO a contract reaches
 * routinely lives in another project and the checker has to be able to follow the import — the same
 * reason the repo sweep in `@webpieces/api-doc-model`'s own spec builds one program rather than one
 * per file.
 */
export class ApiDocRulesScan {
    /**
     * Every `@InvalidEndpointForMcp` endpoint met on a file the MCP rule applies to.
     *
     * Collected even on a run with no findings at all, because restating them IS the feature: the
     * alternative considered in #1014 was a one-off warning when somebody adds one, and a warning
     * printed once at the moment of the decision is read by the one person who already knows.
     */
    private readonly exclusions: McpExclusion[] = [];

    constructor(
        private readonly workspaceRoot: string,
        private readonly projectInfos: Map<string, ProjectInfo>,
        /** OFF unless a caller read otherwise out of webpieces.config.json — see `defaultRules`. */
        private readonly openApiRule: ApiDocRule = ApiDocRule.off(OPENAPI_RULE),
        private readonly mcpRule: ApiDocRule = ApiDocRule.off(MCP_RULE),
    ) {}

    run(): ApiDocRulesFindings {
        if (!this.openApiRule.enabled && !this.mcpRule.enabled) return ApiDocRulesFindings.empty();
        const files = this.contractFiles();
        if (files.length === 0) return ApiDocRulesFindings.empty();

        const openApi = this.openApiRule.enabled ? new DefectCollector(OPENAPI_RULE) : undefined;
        const mcp = this.mcpRule.enabled ? new DefectCollector(MCP_RULE) : undefined;
        const program = ts.createProgram(
            files.map((file: ContractFile) => file.absPath),
            this.compilerOptions(),
        );
        const toolNames = new Map<string, string>();
        for (const file of files) {
            const sink = new DefectSink(
                file.openApi ? openApi : undefined,
                file.mcp ? mcp : undefined,
            );
            this.judgeFile(file, program, sink, toolNames);
        }
        return new ApiDocRulesFindings(
            openApi?.findings() ?? new ApiRuleFindings([], []),
            mcp?.findings() ?? new ApiRuleFindings([], []),
            this.exclusions,
        );
    }

    /** Every contract in one file, or the ONE refusal that stopped the file being read at all. */
    private judgeFile(
        file: ContractFile,
        program: ts.Program,
        sink: DefectSink,
        toolNames: Map<string, string>,
    ): void {
        if (!sink.anyRuleRuns()) return;
        const source = program.getSourceFile(file.absPath);
        if (source === undefined) return;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an extraction refusal IS a finding; it is reported, not propagated
        try {
            for (const model of new ApiDocExtractor().extractAllFrom(program, source)) {
                this.judgeModel(model, source, sink, toolNames);
            }
        } catch (err: unknown) {
            //const error = toError(err);
            if (!(err instanceof ApiDocExtractionError)) throw err;
            this.reportExtractionFailure(err, file, source, sink);
        }
    }

    /**
     * An extraction that REFUSED. Reported under the shared list because it stops BOTH documents:
     * `@Endpoint` arguments that cannot be constant-folded, a bound on a non-numeric field, and the
     * `@ApiType(..., MCP)` ⇔ `@WpMcpTool` biconditional all fail here, before a model exists.
     */
    private reportExtractionFailure(
        error: ApiDocExtractionError,
        file: ContractFile,
        source: ts.SourceFile,
        sink: DefectSink,
    ): void {
        const site = Site.parse(error.location, file.absPath);
        sink.shared(
            (): ApiContractDefect => new ApiContractDefect(
                contractNamesIn(source)[0] ?? path.basename(file.absPath),
                '',
                `the contract cannot be read at all — ${error.message}`,
                site.relativeTo(this.workspaceRoot),
                error.cure,
                [],
            ),
            site,
        );
    }

    /** ONE contract: the shared OpenAPI checks, then the MCP-only ones. */
    private judgeModel(
        model: ApiDocModel,
        source: ts.SourceFile,
        sink: DefectSink,
        toolNames: Map<string, string>,
    ): void {
        const lines = contractLinesOf(source, model.contractName);
        this.judgeUnmapped(model, sink, source.fileName);
        this.judgeUnknownValues(model, sink, source.fileName);
        this.judgeRpcResponses(model, source, lines, sink);
        this.judgeTools(model, source, lines, sink, toolNames);
    }

    /** Everything `TypeResolver` could not represent — the generator's OWN verdict, re-worded. */
    private judgeUnmapped(model: ApiDocModel, sink: DefectSink, fallback: string): void {
        for (const unmapped of model.unmapped) {
            const site = Site.parse(unmapped.location, fallback);
            const verdict = classifyUnmapped(unmapped);
            sink.shared(
                (): ApiContractDefect => new ApiContractDefect(
                    model.contractName,
                    '',
                    verdict.what,
                    site.relativeTo(this.workspaceRoot),
                    verdict.cure,
                    model.apiTypes,
                ),
                site,
            );
        }
    }

    /** `Record<string, unknown>`, `unknown[]`, `x: unknown` — by VALUE TYPE, never by spelling. */
    private judgeUnknownValues(model: ApiDocModel, sink: DefectSink, fallback: string): void {
        for (const type of model.types.values()) {
            for (const field of type.fields) {
                if (!carriesUnknown(field.type)) continue;
                const site = Site.parse(field.location, fallback);
                sink.shared(
                    (rule: string): ApiContractDefect =>
                        new ApiContractDefect(
                            model.contractName,
                            '',
                            `'${type.name}.${field.name}' publishes an 'unknown' value, so the ` +
                                'document states no shape for it at all',
                            site.relativeTo(this.workspaceRoot),
                            unknownValueCure(rule),
                            model.apiTypes,
                        ),
                    site,
                );
            }
        }
    }

    /**
     * An RPC must NAME a response DTO, even an empty one.
     *
     * `Promise<void>` on a `cloudtasks` or `cron` endpoint is the CONTRACT — fire-and-forget, nothing
     * to shape — and is allowed. On an RPC it is a one-way door: a `void` response can never gain a
     * field without breaking every generated client, where `{}` grows additively forever. This is a
     * contract-EVOLUTION rule, which is why it is here and not in the MCP half: it is worth having on
     * an RPC that never becomes a tool.
     */
    private judgeRpcResponses(
        model: ApiDocModel,
        source: ts.SourceFile,
        lines: ContractLines,
        sink: DefectSink,
    ): void {
        for (const endpoint of model.endpoints) {
            if (endpoint.kind !== RPC_KIND) continue;
            if (endpoint.response !== undefined && !isVoidLike(endpoint.response)) continue;
            const site = new Site(source.fileName, lines.lineOf(endpoint.methodName));
            sink.shared(
                (): ApiContractDefect => new ApiContractDefect(
                    model.contractName,
                    endpoint.methodName,
                    'an RPC returns nothing a document can name (void, unknown, or no declared ' +
                        'return type)',
                    site.relativeTo(this.workspaceRoot),
                    VOID_RPC_CURE,
                    model.apiTypes,
                ),
                site,
            );
        }
    }

    /** Everything `McpToolRegistry` refuses to boot on, plus whatever the renderer cannot render. */
    private judgeTools(
        model: ApiDocModel,
        source: ts.SourceFile,
        lines: ContractLines,
        sink: DefectSink,
        toolNames: Map<string, string>,
    ): void {
        const renderer = new McpSchemaRenderer(model);
        for (const endpoint of model.endpoints) {
            if (endpoint.invalidForMcp !== undefined) {
                if (!sink.mcpRuns()) continue;
                // @InvalidEndpointForMcp IS the answer to "could this be a tool". The decorator
                // carries the argument, so the rule asks nothing further and no webpieces-disable is
                // needed — a suppression would be a second, weaker spelling of the same declaration.
                this.exclusions.push(
                    new McpExclusion(
                        model.contractName,
                        endpoint.methodName,
                        endpoint.invalidForMcp,
                        new Site(
                            source.fileName,
                            lines.lineOf(endpoint.methodName),
                        ).relativeTo(this.workspaceRoot),
                    ),
                );
                continue;
            }
            if (endpoint.mcpTool === undefined) continue;
            const site = new Site(source.fileName, lines.lineOf(endpoint.methodName));
            for (const failure of toolFailures(endpoint, renderer, toolNames, model)) {
                sink.mcpOnly(
                    new ApiContractDefect(
                        model.contractName,
                        endpoint.methodName,
                        failure.what,
                        site.relativeTo(this.workspaceRoot),
                        failure.cure,
                        model.apiTypes,
                    ),
                    site,
                );
            }
        }
        for (const methodName of lines.toolsWithoutEndpoint) {
            const site = new Site(source.fileName, lines.lineOf(methodName));
            sink.mcpOnly(
                new ApiContractDefect(
                    model.contractName,
                    methodName,
                    'carries @WpMcpTool but is not an @Endpoint, so it is not routed at all',
                    site.relativeTo(this.workspaceRoot),
                    "Add @Endpoint(POST, '/path', READ, RPC) to it, or drop the @WpMcpTool.",
                    model.apiTypes,
                ),
                site,
            );
        }
    }

    /** Every non-test `.ts` under a project's `src` whose text DECLARES an `@ApiPath` contract. */
    private contractFiles(): ContractFile[] {
        const found: ContractFile[] = [];
        for (const info of this.projectInfos.values()) {
            if (info.root === '' || info.root === '.') continue;
            const openApi =
                this.openApiRule.enabled &&
                !matchesAnyGlob(info.root, this.openApiRule.allowedPaths);
            const mcp =
                this.mcpRule.enabled && !matchesAnyGlob(info.root, this.mcpRule.allowedPaths);
            if (!openApi && !mcp) continue;
            const srcDir = path.join(path.resolve(this.workspaceRoot, info.root), 'src');
            if (!fs.existsSync(srcDir)) continue;
            for (const file of collectTsFiles(srcDir)) {
                if (isTestFile(file)) continue; // a fixture is not a published contract
                if (!DECLARES_CONTRACT.test(fs.readFileSync(file, 'utf8'))) continue;
                found.push(new ContractFile(file, openApi, mcp));
            }
        }
        return found.sort((a: ContractFile, b: ContractFile) => a.absPath.localeCompare(b.absPath));
    }

    /**
     * `tsconfig.base.json`'s options when the workspace has one, so an `@webpieces/*` import in a
     * contract RESOLVES and the checker can follow a DTO into another project. Without that the
     * resolver reports every cross-project type as unmapped, which would be a rule failing on its
     * own inability to read rather than on anything the author wrote.
     */
    private compilerOptions(): ts.CompilerOptions {
        const base = path.join(this.workspaceRoot, 'tsconfig.base.json');
        const declared = fs.existsSync(base)
            ? ts.parseJsonConfigFileContent(
                  ts.readConfigFile(base, ts.sys.readFile).config,
                  ts.sys,
                  this.workspaceRoot,
              ).options
            : {};
        return {
            ...declared,
            noEmit: true,
            skipLibCheck: true,
            types: [],
            experimentalDecorators: true,
        };
    }
}
