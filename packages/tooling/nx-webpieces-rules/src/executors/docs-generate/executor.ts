/**
 * docs-generate Executor
 *
 * Renders the static API reference site from a document `openapi-generate` already wrote into the api
 * library's build output, and writes the site into `<projectRoot>/<siteDir>` — a gitignored directory
 * of the project, for HOSTING. It is deliberately not written into the package: a docs site is
 * something you deploy, not something an npm consumer installs.
 *
 * Consumers do not declare this executor. The nx-webpieces-rules plugin INFERS the target on a project
 * tagged `generate:docs-site` (which implies `generate:openapi`), with `dependsOn: ["openapi-generate"]`;
 * project.json states only the options, under the same target name:
 *
 *   "docs-generate": {
 *     "options": { "document": "public-openapi.json", "siteDir": "generated-docs", "prose": "<project>/docs" }
 *   }
 *
 * and the repo's .gitignore carries `generated-docs/`.
 *
 * `document` should be the PARTNER-facing document: a site built from `full-private-openapi.json`
 * publishes exactly the operations somebody decided not to publish. `prose` is optional because a site
 * with no prose pages is a legal site; `document` and `siteDir` are required and have no defaults.
 *
 * The renderer is the CONSUMER's `@webpieces/docs-site`, resolved from its node_modules and
 * version-checked; this plugin bundles no copy of it.
 */

import type { ExecutorContext } from '@nx/devkit';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { Option, RepoScratchDirs, RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutorResult } from '../../executor-result';
import { ConsumerBinRequest, ConsumerBinResolver } from '../../lib/api-docs/consumer-bin-resolver';
import { DOCS_SITE } from '../../lib/api-docs/generator-package';
import { GeneratorRunner } from '../../lib/api-docs/generator-runner';
import { GeneratorTarget, StagedOutput } from '../../lib/api-docs/generator-target';
import { toError } from '../../toError';

export interface DocsGenerateOptions {
    /** A document name inside the api library's build output, e.g. `public-openapi.json`. Required. */
    document?: string;
    /** The site's directory, relative to the project root, e.g. `generated-docs`. Required. */
    siteDir?: string;
    /** Workspace-relative directory holding `docs.manifest.json` and its markdown. Optional. */
    prose?: string;
}

const RULE_NAME = GeneratedApiDocsLayout.DOCS_TARGET;

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
        target.assertDependsOn(GeneratedApiDocsLayout.OPENAPI_TARGET);
        const document = target.requiredOption(options.document, 'document');
        const siteOut = target.insideProject(target.requiredOption(options.siteDir, 'siteDir'), 'siteDir');
        const documentsDir = target.documentsDir();
        const spec = path.join(documentsDir, document);
        if (!fs.existsSync(spec)) {
            throw new RuleFailError(
                RULE_NAME,
                `${path.relative(context.root, spec)} does not exist, so there is nothing to render. ` +
                    `openapi-generate writes only the documents the contracts' @ApiType(...) ask for.`,
                undefined,
                undefined,
                [new Option(`Set options.document to a file openapi-generate writes into ${path.relative(context.root, documentsDir)}`, true)],
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
            // survive into what gets hosted.
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
