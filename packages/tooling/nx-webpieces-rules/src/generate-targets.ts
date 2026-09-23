/**
 * The API-document targets the inference plugin adds to a project that OPTS IN with an nx tag:
 *
 * | tag | inferred target(s) |
 * |---|---|
 * | `generate:openapi` | `openapi-generate` |
 * | `generate:docs-site` | `openapi-generate` + `docs-generate` (a site is rendered from a document) |
 *
 * The plugin owns the executor, `cache`, `inputs` and `outputs` — the parts that are the same for every
 * consumer and that a hand-written target gets wrong silently (a missed output is a cache hit that
 * restores a package WITHOUT its documents). The consumer states only what is theirs to decide, in its
 * project.json under the SAME target name, which nx merges over what is inferred here:
 *
 * - `openapi-generate`: `dependsOn` (the ONE compile target whose outputPath it writes into) and
 *   `options.manifest` / `options.format`;
 * - `docs-generate`: `options.document` / `options.siteDir` (and optionally `options.prose`).
 *
 * None of those has a default (`.claude/rules/no-rule-defaults.md`): a missing one fails the run naming
 * the key. An untagged project costs one in-memory tag check — no source scan, no `@ApiType` search.
 * A tag the INSTALLED plugin does not know yet is ignored by it, whereas a project.json naming an
 * executor the installed plugin lacks breaks the graph load — which is why opting in is a tag and not
 * a hand-written executor target.
 *
 * The api project's shape (`compile` → `openapi-generate` → `build` as an `nx:noop`) is enforced by
 * `validate-nx-wiring`, not here: this runs while nx builds the graph, where a throw takes the whole
 * workspace down rather than naming one project's fix.
 */

import type { TargetConfiguration } from '@nx/devkit';
import { GeneratedApiDocsLayout, LayoutTargets } from '@webpieces/core-util';
import { readFileSync } from 'fs';
import { join } from 'path';

export const GENERATE_OPENAPI_TAG = 'generate:openapi';
export const GENERATE_DOCS_SITE_TAG = 'generate:docs-site';

/** The two fields of the raw project.json the inference reads. Data-only. */
export class RawProjectJson {
    constructor(
        readonly name: string,
        readonly tags: readonly string[],
        readonly targets: LayoutTargets,
    ) {}
}

/** The fields of a project.json that tag-driven inference reads, as they sit in the file. */
type ProjectJsonFields = { name?: string; tags?: string[]; targets?: LayoutTargets };

/** Reads the raw project.json — the tags and the consumer's own target options — at graph time. */
export class RawProjectJsonReader {
    read(workspaceRoot: string, projectFile: string, projectRoot: string): RawProjectJson {
        const raw = JSON.parse(readFileSync(join(workspaceRoot, projectFile), 'utf8')) as ProjectJsonFields;
        return new RawProjectJson(raw.name ?? projectRoot, raw.tags ?? [], raw.targets ?? {});
    }
}

export class GenerateTargets {
    constructor(
        /** Workspace-relative project root. */
        private readonly projectRoot: string,
        private readonly project: RawProjectJson,
    ) {}

    /** The targets the project's tags opt it into — `{}` for an untagged project. */
    infer(): Record<string, TargetConfiguration> {
        const tags = this.project.tags;
        const docs = tags.includes(GENERATE_DOCS_SITE_TAG);
        if (!docs && !tags.includes(GENERATE_OPENAPI_TAG)) return {};
        const targets: Record<string, TargetConfiguration> = {};
        targets[GeneratedApiDocsLayout.OPENAPI_TARGET] = this.openApiGenerate();
        if (docs) targets[GeneratedApiDocsLayout.DOCS_TARGET] = this.docsGenerate();
        return targets;
    }

    /**
     * `outputs` point into the compile target's outputPath, read here from the SAME lookup the
     * executor writes with. When the consumer has not stated `dependsOn` yet there is no outputPath to
     * point at, so no outputs are inferred — and the executor's refusal names the missing `dependsOn`.
     */
    private openApiGenerate(): TargetConfiguration {
        const found = new GeneratedApiDocsLayout(this.projectRoot, this.project.name, this.project.targets)
            .outputTarget().found;
        const outputs = found === undefined
            ? []
            : [
                `{workspaceRoot}/${found.outputPath}/*openapi.json`,
                `{workspaceRoot}/${found.outputPath}/*openapi.yaml`,
                `{workspaceRoot}/${found.outputPath}/mcp-*-tools.json`,
            ];
        return {
            executor: '@webpieces/nx-webpieces-rules:openapi-generate',
            cache: true,
            inputs: ['default', '^default'],
            outputs,
            metadata: {
                technologies: ['nx'],
                description:
                    'Generate the OpenAPI documents + one mcp-<ContractClass>-tools.json per MCP contract into the compile outputPath (tag: generate:openapi)',
            },
        };
    }

    private docsGenerate(): TargetConfiguration {
        return {
            executor: '@webpieces/nx-webpieces-rules:docs-generate',
            dependsOn: [GeneratedApiDocsLayout.OPENAPI_TARGET],
            cache: true,
            inputs: ['default', '^default'],
            outputs: ['{projectRoot}/{options.siteDir}'],
            metadata: {
                technologies: ['nx'],
                description:
                    'Render the static API reference site into <projectRoot>/<siteDir> for hosting (tag: generate:docs-site)',
            },
        };
    }
}
