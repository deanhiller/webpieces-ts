/**
 * openapi-generate Executor
 *
 * Renders a project's contracts to OpenAPI, plus ONE MCP tool catalog per contract
 * (`mcp-<ContractClass>-tools.json`), INTO the outputPath of the target it dependsOn — the api
 * library's `build` (its @nx/js:tsc step) — so the documents are packed and published inside the api library's npm
 * package: a consumer installs the library and has the contract. They are build output, never
 * committed.
 *
 * Consumers do not declare this executor. The nx-webpieces-rules plugin INFERS the target on a project
 * tagged `generate:openapi` (executor, cache, inputs, outputs); project.json states only what is the
 * consumer's to decide, under the same target name:
 *
 *   "tags": ["generate:openapi"],
 *   "targets": {
 *     "build": { "executor": "@nx/js:tsc", "outputs": ["{options.outputPath}"],
 *                "options": { "outputPath": "dist/<project>", ... } },
 *     "openapi-generate": {
 *       "dependsOn": ["build"],
 *       "options": { "manifest": "<project>/openapi.manifest.json", "format": "both" }
 *     }
 *   }
 *
 * and dependents pull it in through nx.json: `"^openapi-generate"` in every targetDefaults entry
 * governing a `build` or `test` (#1023 — see GenerateWiring).
 *
 * The output directory is the outputPath of the ONE target `dependsOn` names (GeneratedApiDocsLayout
 * in @webpieces/core-util — the same lookup the MCP server reads with), never a hardcoded target name
 * and never an assumed dist/. `outputs` are CHECKED against what a run wrote — see GeneratorTarget. The
 * generator itself is the CONSUMER's `@webpieces/openapi-generator`, resolved from its node_modules and
 * version-checked; this plugin bundles no copy of it (see ConsumerBinResolver).
 */

import type { ExecutorContext } from '@nx/devkit';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { RepoScratchDirs, RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutorResult } from '../../executor-result';
import { ConsumerBinRequest, ConsumerBinResolver } from '../../lib/api-docs/consumer-bin-resolver';
import { OPENAPI_GENERATOR } from '../../lib/api-docs/generator-package';
import { GeneratorRunner } from '../../lib/api-docs/generator-runner';
import { GeneratorTarget, StagedOutput } from '../../lib/api-docs/generator-target';
import { toError } from '../../toError';

export interface OpenApiGenerateOptions {
    /** Workspace-relative path to the project's `openapi.manifest.json`. Required; no default. */
    manifest?: string;
    /** `json`, `yaml` or `both`. Required; no default — it decides what the package ships. */
    format?: string;
}

const RULE_NAME = GeneratedApiDocsLayout.OPENAPI_TARGET;

/** Everything except the process-facing reporting, so the suite drives it exactly as nx does. */
export class OpenApiGenerate {
    constructor(
        private readonly resolver: ConsumerBinResolver = new ConsumerBinResolver(),
        private readonly runner: GeneratorRunner = new GeneratorRunner(),
        private readonly scratch: RepoScratchDirs = new RepoScratchDirs(),
    ) {}

    /** @returns the files written, absolute. Throws RuleFailError on every refusal. */
    run(options: OpenApiGenerateOptions, context: ExecutorContext): string[] {
        const target = GeneratorTarget.of(RULE_NAME, context);
        const outDir = target.documentsDir();
        const manifest = target.requiredOption(options.manifest, 'manifest');
        const format = target.requiredOption(options.format, 'format');
        const bin = this.resolver.resolve(new ConsumerBinRequest(
            RULE_NAME, OPENAPI_GENERATOR, [path.join(context.root, target.projectRoot), context.root]));

        const staging = this.scratch.make(context.root, 'wp-openapi-generate-');
        // webpieces-disable no-unmanaged-exceptions -- try/FINALLY only, nothing is caught: the staging
        // directory is removed however this ends, and every throw still reaches runExecutor below
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const run = this.runner.run(bin, [
                '--manifest', path.resolve(context.root, manifest), '--out', staging, '--format', format,
            ], context.root);
            if (!run.ok) {
                throw new RuleFailError(
                    RULE_NAME,
                    `${bin.packageName} ${bin.version} refused ${manifest}:\n${run.output}`,
                );
            }
            const written = new StagedOutput().publish(staging, outDir);
            target.assertOutputsCover(written);
            return written;
        } finally {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
}

// webpieces-disable no-function-outside-class -- nx executor module: nx resolves a default-export function here
export default async function runExecutor(
    options: OpenApiGenerateOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this IS the executor's single top-level handler
    try {
        const written = new OpenApiGenerate().run(options, context);
        for (const file of written) console.log(`wrote ${path.relative(context.root, file)}`);
        return new ExecutorResult(true);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`❌ ${RULE_NAME}: ${error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message}`);
        return new ExecutorResult(false);
    }
}
