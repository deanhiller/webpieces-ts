/**
 * docs-generate Executor
 *
 * Renders the static API reference site from a document `openapi-generate` already wrote into the
 * project's build `outputPath`, and writes the site into `<outputPath>/<siteDir>` — build output,
 * published with the package, never committed.
 *
 * Usage (project.json):
 *
 *   "docs-generate": {
 *     "executor": "@webpieces/nx-webpieces-rules:docs-generate",
 *     "dependsOn": ["openapi-generate"],
 *     "cache": true,
 *     "inputs": ["default", "^default"],
 *     "outputs": ["{workspaceRoot}/dist/<project>/docs-site"],
 *     "options": { "document": "public-openapi.json", "siteDir": "docs-site", "prose": "<project>/docs" }
 *   }
 *
 * `document` should be the PARTNER-facing document: a site built from `full-private-openapi.json`
 * publishes exactly the operations somebody decided not to publish. `prose` is optional because a site
 * with no prose pages is a legal site; `document` and `siteDir` are required and have no defaults.
 *
 * The renderer is the CONSUMER's `@webpieces/docs-site`, resolved from its node_modules and
 * version-checked; this plugin bundles no copy of it.
 */

import type { ExecutorContext } from '@nx/devkit';
import { ConsumerBinRequest, ConsumerBinResolver, DOCS_SITE, GeneratorRunner } from '@webpieces/pr-gate';
import { Option, RepoScratchDirs, RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutorResult } from '../../executor-result';
import { GeneratorTarget, StagedOutput } from '../../lib/generated-docs/generator-target';
import { toError } from '../../toError';

export interface DocsGenerateOptions {
    /** A document name inside the build outputPath, e.g. `public-openapi.json`. Required. */
    document?: string;
    /** The site's directory name inside the build outputPath, e.g. `docs-site`. Required. */
    siteDir?: string;
    /** Workspace-relative directory holding `docs.manifest.json` and its markdown. Optional. */
    prose?: string;
}

const RULE_NAME = 'docs-generate';

/** Everything except the process-facing reporting, so the suite drives it exactly as nx does. */
export class DocsGenerate {
    constructor(
        private readonly resolver: ConsumerBinResolver = new ConsumerBinResolver(),
        private readonly runner: GeneratorRunner = new GeneratorRunner(),
        private readonly scratch: RepoScratchDirs = new RepoScratchDirs(),
    ) {}

    /** @returns the files written, absolute. Throws RuleFailError on every refusal. */
    run(options: DocsGenerateOptions, context: ExecutorContext): string[] {
        const target = GeneratorTarget.of(RULE_NAME, context);
        target.assertDependsOn('openapi-generate');
        const document = target.requiredOption(options.document, 'document');
        const siteDir = target.requiredOption(options.siteDir, 'siteDir');
        const outDir = target.buildOutputDir();
        const spec = path.join(outDir, document);
        if (!fs.existsSync(spec)) {
            throw new RuleFailError(
                RULE_NAME,
                `${path.relative(context.root, spec)} does not exist, so there is nothing to render. ` +
                    `openapi-generate writes only the documents the contracts' @ApiType(...) ask for.`,
                undefined,
                undefined,
                [new Option(`Set options.document to a file openapi-generate writes into ${path.relative(context.root, outDir)}`, true)],
            );
        }
        const bin = this.resolver.resolve(new ConsumerBinRequest(
            RULE_NAME, DOCS_SITE, [path.join(context.root, target.projectRoot), context.root]));

        const staging = this.scratch.make(context.root, 'wp-docs-generate-');
        // webpieces-disable no-unmanaged-exceptions -- try/FINALLY only, nothing is caught: the staging
        // directory is removed however this ends, and every throw still reaches runExecutor below
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const args = ['--spec', spec, '--out', staging];
            if (options.prose !== undefined) args.push('--prose', path.resolve(context.root, options.prose));
            const run = this.runner.run(bin, args, context.root);
            if (!run.ok) {
                throw new RuleFailError(RULE_NAME, `${bin.packageName} ${bin.version} refused ${document}:\n${run.output}`);
            }
            // The site REPLACES the previous one: a page for an operation that no longer exists must not
            // survive into the published package.
            const siteOut = path.join(outDir, siteDir);
            fs.rmSync(siteOut, { recursive: true, force: true });
            const written = new StagedOutput().publish(staging, siteOut);
            target.assertOutputsCover(written);
            return written;
        } finally {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
}

// webpieces-disable no-function-outside-class -- nx executor module: nx resolves a default-export function here
export default async function runExecutor(
    options: DocsGenerateOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this IS the executor's single top-level handler
    try {
        const written = new DocsGenerate().run(options, context);
        console.log(`wrote ${written.length} file(s) of the docs site for ${context.projectName ?? ''}`);
        return new ExecutorResult(true);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`❌ ${RULE_NAME}: ${error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message}`);
        return new ExecutorResult(false);
    }
}
