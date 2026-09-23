/**
 * The build SHAPE a project opting into generated API documents must have, checked by
 * `validate-nx-wiring` (#1021):
 *
 * ```
 * <api-lib>:compile           @nx/js:tsc → its outputPath                   (dependsOn ^build)
 * <api-lib>:openapi-generate  dependsOn ["compile"] → writes into compile's outputPath
 * <api-lib>:build             nx:noop, dependsOn ["compile", "openapi-generate"]
 * ```
 *
 * Why that shape and no other: nx `dependsOn` only points BACKWARD, generation must run AFTER tsc
 * (whose cleanup wipes the outputPath), and every consumer only ever asks for `^build` — servers,
 * Dockerfiles (`nx run-many -t build -p lang-server`). With `build` as a noop over both, every existing
 * `^build` pulls generation in with zero consumer change.
 *
 * And one rule for the projects that DEPEND on such a library: their `test` must dependsOn `^build`.
 * A server spec that boots the MCP server reads the library's generated tool catalogs out of its build
 * output (`McpToolCatalog.fromPackages` on a workspace source directory), so a test run that did not
 * build the library first fails on a missing file — or, worse, passes against a stale one.
 */

import type { ProjectConfiguration, TargetConfiguration, TargetDependencyConfig } from '@nx/devkit';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { Option, RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { GENERATE_DOCS_SITE_TAG, GENERATE_OPENAPI_TAG } from '../../generate-targets';

/** One project's wiring defect, and the exact project.json edit that fixes it. Data-only. */
export class GenerateWiringProblem {
    constructor(
        readonly project: string,
        readonly problem: string,
        readonly cure: string,
    ) {}
}

/** The one field of an nx graph dependency this check reads. Data-only. */
export class ProjectDependency {
    constructor(readonly target: string) {}
}

type DependsOnEntry = string | TargetDependencyConfig;

/** The executors the plugin infers from a tag — a project.json naming one by hand is a second opt-in. */
const INFERRED_EXECUTORS: readonly string[] = [
    '@webpieces/nx-webpieces-rules:openapi-generate',
    '@webpieces/nx-webpieces-rules:docs-generate',
];

export class GenerateWiring {
    constructor(
        /** nx's RESOLVED project configurations — targetDefaults and inferred targets merged in. */
        private readonly projects: Readonly<Record<string, ProjectConfiguration>>,
        /** The project graph's dependencies, by source project. */
        private readonly dependencies: Readonly<Record<string, readonly ProjectDependency[]>>,
    ) {}

    /** The projects tagged to generate API documents. */
    generating(): string[] {
        return Object.keys(this.projects)
            .filter((name: string) => {
                const tags = this.projects[name]!.tags ?? [];
                return tags.includes(GENERATE_OPENAPI_TAG) || tags.includes(GENERATE_DOCS_SITE_TAG);
            })
            .sort();
    }

    /** The problems as ONE structured failure: each problem in the message, each fix as an Option. */
    failure(problems: readonly GenerateWiringProblem[]): RuleFailError {
        return new RuleFailError(
            'nx-wiring',
            'A project generating API documents is not wired so that ^build generates them:\n' +
                problems.map((each: GenerateWiringProblem) => `  ${each.project}: ${each.problem}`).join('\n'),
            undefined,
            undefined,
            problems.map((each: GenerateWiringProblem) => new Option(`${each.project}: ${each.cure}`, true)),
        );
    }

    /** Render {@link failure} through the one human renderer, as validate-nx-wiring's report. */
    report(problems: readonly GenerateWiringProblem[]): void {
        console.error(`\n❌ ${renderRuleFailForHuman(this.failure(problems))}\n`);
    }

    problems(): GenerateWiringProblem[] {
        const generating = this.generating();
        const problems: GenerateWiringProblem[] = this.handWritten(new Set(generating));
        for (const name of generating) problems.push(...this.shapeOf(name));
        problems.push(...this.dependentsOf(new Set(generating)));
        return problems;
    }

    /**
     * An UNTAGGED project naming an inferred executor by hand: a second way to opt in, which also slips
     * past the shape check (and breaks the graph load the day the installed plugin lacks the executor).
     */
    private handWritten(generating: ReadonlySet<string>): GenerateWiringProblem[] {
        const problems: GenerateWiringProblem[] = [];
        for (const name of Object.keys(this.projects).sort()) {
            if (generating.has(name)) continue;
            const project = this.projects[name]!;
            for (const [targetName, target] of Object.entries(project.targets ?? {})) {
                if (target.executor === undefined || !INFERRED_EXECUTORS.includes(target.executor)) continue;
                problems.push(new GenerateWiringProblem(
                    name,
                    `targets.${targetName} names the executor ${target.executor} by hand, and the project has no ` +
                        `"${GENERATE_OPENAPI_TAG}" / "${GENERATE_DOCS_SITE_TAG}" tag. Opting in is the tag; the plugin ` +
                        'infers the executor.',
                    `Add "${targetName === GeneratedApiDocsLayout.DOCS_TARGET ? GENERATE_DOCS_SITE_TAG : GENERATE_OPENAPI_TAG}" ` +
                        `to "tags" in ${project.root}/project.json and delete the "executor" line of targets.${targetName}.`,
                ));
            }
        }
        return problems;
    }

    private shapeOf(name: string): GenerateWiringProblem[] {
        const project = this.projects[name]!;
        const where = `${project.root}/project.json`;
        const targets = project.targets ?? {};
        const lookup = new GeneratedApiDocsLayout(project.root, name, targets).outputTarget();
        if (lookup.found === undefined) {
            return [new GenerateWiringProblem(name, lookup.problem!.problem, lookup.problem!.cure)];
        }
        const compileName = lookup.found.targetName;
        const problems: GenerateWiringProblem[] = [];
        if (!this.names(targets[compileName], '^build')) {
            problems.push(new GenerateWiringProblem(
                name,
                `${name}:${compileName} (the target ${GeneratedApiDocsLayout.OPENAPI_TARGET} writes into) does ` +
                    'not dependsOn "^build", so upstream libraries are not built before it compiles.',
                `Add "dependsOn": ["^build"] to targets.${compileName} in ${where}.`,
            ));
        }
        const build = targets['build'];
        const buildOk = build !== undefined && build.executor === 'nx:noop' &&
            this.names(build, compileName) && this.names(build, GeneratedApiDocsLayout.OPENAPI_TARGET);
        if (!buildOk) {
            problems.push(new GenerateWiringProblem(
                name,
                `${name}:build must be an nx:noop over "${compileName}" and "${GeneratedApiDocsLayout.OPENAPI_TARGET}" ` +
                    `— it is what every consumer's ^build asks for, so it is what pulls generation in — and it is ` +
                    `${build === undefined ? 'missing' : `${build.executor ?? '(no executor)'} dependsOn ${JSON.stringify(build.dependsOn ?? [])}`}.`,
                `Set targets.build in ${where} to ` +
                    `{ "executor": "nx:noop", "dependsOn": ["${compileName}", "${GeneratedApiDocsLayout.OPENAPI_TARGET}"] }, ` +
                    `moving the @nx/js:tsc options to targets.${compileName}.`,
            ));
        }
        return problems;
    }

    private dependentsOf(generating: ReadonlySet<string>): GenerateWiringProblem[] {
        const problems: GenerateWiringProblem[] = [];
        for (const name of Object.keys(this.projects).sort()) {
            const upstream = (this.dependencies[name] ?? [])
                .map((dependency: ProjectDependency) => dependency.target)
                .filter((target: string) => generating.has(target) && target !== name);
            const test = this.projects[name]!.targets?.['test'];
            if (upstream.length === 0 || test === undefined || this.names(test, '^build')) continue;
            problems.push(new GenerateWiringProblem(
                name,
                `${name} depends on ${[...new Set(upstream)].sort().join(', ')}, which generate${upstream.length === 1 ? 's' : ''} ` +
                    'API documents and MCP tool catalogs into their build output, and its test target does not ' +
                    'dependsOn "^build" — a spec that boots the MCP server would read catalogs that were never built.',
                `Add "dependsOn": ["^build"] to targets.test in ${this.projects[name]!.root}/project.json.`,
            ));
        }
        return problems;
    }

    /** Whether `target` dependsOn `wanted` — `^x` for the upstream form, `x` for a sibling. */
    private names(target: TargetConfiguration | undefined, wanted: string): boolean {
        const upstream = wanted.startsWith('^');
        const name = upstream ? wanted.slice(1) : wanted;
        return (target?.dependsOn ?? []).some((entry: DependsOnEntry) => {
            if (typeof entry === 'string') return entry === wanted;
            return entry.target === name && (entry.dependencies === true) === upstream;
        });
    }
}
