/**
 * The CHAINED half of `validate-nx-wiring` (#1058): DTO libraries tagged `generate:openapi-components`
 * publish `components.openapi.json`, and every document that `$ref`s one must be generated AFTER it.
 *
 * ```
 * <dto-lib>:openapi-components-generate   dependsOn ["build", "^openapi-components-generate"]
 * <api-lib>:openapi-generate              dependsOn ["build", "^openapi-components-generate"]
 * ```
 *
 * The `^` edge is what orders a chain of any depth — contract lib → DTO lib A → DTO lib B — because
 * nx skips a dependency without the target and keeps walking ITS dependencies. Without it nx may render
 * a contract document before the library document it references exists, and the generator's
 * fail-closed refusal ("never generated") fires intermittently, mostly in CI. So it is refused here,
 * on the resolved graph, with the exact `dependsOn` to write.
 *
 * The tag itself is allowed only on a `role:api-lib` project (#1064, D5): a components document puts a
 * library's types on the wire, and every wire type is declared in an api library. Tagging a general
 * library such as `company-core` must not be a way out of moving the type.
 */

import type { ProjectConfiguration, TargetConfiguration, TargetDependencyConfig } from '@nx/devkit';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { GENERATE_OPENAPI_COMPONENTS_TAG } from '../../generate-targets';
import { DeclaredDependsOn, GenerateWiringProblem, ProjectDependency } from './generate-wiring';

type DependsOnEntry = string | TargetDependencyConfig;

/** The tsc target a library keeps, and its generating target dependsOn. */
const BUILD_TARGET = 'build';
const COMPONENTS_TARGET = GeneratedApiDocsLayout.COMPONENTS_TARGET;
const UPSTREAM_COMPONENTS = `^${COMPONENTS_TARGET}`;
const API_LIB_ROLE_TAG = 'role:api-lib';

/** The targets that READ upstream components documents, and so must run after them. */
const READING_TARGETS: readonly string[] = [COMPONENTS_TARGET, GeneratedApiDocsLayout.OPENAPI_TARGET];

export class ComponentsWiring {
    constructor(
        private readonly projects: Readonly<Record<string, ProjectConfiguration>>,
        private readonly dependencies: Readonly<Record<string, readonly ProjectDependency[]>>,
        private readonly declared: DeclaredDependsOn,
    ) {}

    /** The DTO libraries tagged to publish a components document. */
    libraries(): string[] {
        return Object.keys(this.projects)
            .filter((name: string) => (this.projects[name]!.tags ?? []).includes(GENERATE_OPENAPI_COMPONENTS_TAG))
            .sort();
    }

    problems(): GenerateWiringProblem[] {
        const libraries = new Set(this.libraries());
        const problems: GenerateWiringProblem[] = [];
        for (const name of this.libraries()) problems.push(...this.roleOf(name), ...this.shapeOf(name));
        for (const name of Object.keys(this.projects).sort()) {
            const upstream = this.librariesUpstreamOf(name, libraries);
            if (upstream.length === 0) continue;
            for (const targetName of READING_TARGETS) {
                const target = this.projects[name]!.targets?.[targetName];
                if (target === undefined || this.namesUpstream(target)) continue;
                problems.push(this.missingEdge(name, targetName, target, upstream));
            }
        }
        return problems;
    }

    /** Only a `role:api-lib` publishes a components document (D5). */
    private roleOf(name: string): GenerateWiringProblem[] {
        const project = this.projects[name]!;
        const tags = project.tags ?? [];
        if (tags.includes(API_LIB_ROLE_TAG)) return [];
        const carried = tags.filter((tag: string) => tag.startsWith('role:')).join(', ') || 'no role tag';
        return [new GenerateWiringProblem(
            name,
            `${name} is tagged "${GENERATE_OPENAPI_COMPONENTS_TAG}" but carries ${carried} — only a role:api-lib ` +
                'publishes a components document, because every type a contract reaches is declared in an api library.',
            `${name}: in ${project.root}/project.json, drop "${GENERATE_OPENAPI_COMPONENTS_TAG}" and move the wire ` +
                `types into a role:api-lib DTO library tagged with it — or, when ${name} holds only contracts and ` +
                'wire types, retag it role:api-lib.',
        )];
    }

    /** `openapi-components-generate` dependsOn exactly the library's own `build`, the tsc target. */
    private shapeOf(name: string): GenerateWiringProblem[] {
        const project = this.projects[name]!;
        const lookup = new GeneratedApiDocsLayout(project.root, name, project.targets ?? {})
            .outputTarget(COMPONENTS_TARGET);
        if (lookup.found === undefined) {
            return [new GenerateWiringProblem(name, lookup.problem!.problem, `${name}: ${lookup.problem!.cure}`)];
        }
        if (lookup.found.targetName === BUILD_TARGET) return [];
        return [new GenerateWiringProblem(
            name,
            `${name}:${COMPONENTS_TARGET} dependsOn "${lookup.found.targetName}", and must dependsOn "${BUILD_TARGET}" — ` +
                'the library\'s @nx/js:tsc target keeps the name build (TS6059, nrwl/nx#18257).',
            `${name}: in ${project.root}/project.json, name the @nx/js:tsc target "${BUILD_TARGET}" and set ` +
                `targets.${COMPONENTS_TARGET}.dependsOn to ["${BUILD_TARGET}", "${UPSTREAM_COMPONENTS}"].`,
        )];
    }

    private missingEdge(
        name: string,
        targetName: string,
        target: TargetConfiguration,
        upstream: readonly string[],
    ): GenerateWiringProblem {
        const where = `${this.projects[name]!.root}/project.json`;
        const wanted = [...((target.dependsOn ?? []) as DependsOnEntry[]), UPSTREAM_COMPONENTS];
        const line = `[${wanted.map((entry: DependsOnEntry) => JSON.stringify(entry)).join(', ')}]`;
        const replaces = this.declared.declares(name, targetName)
            ? ''
            : ' (a project.json dependsOn replaces nx.json targetDefaults, which is why it lists every entry)';
        return new GenerateWiringProblem(
            `${name}:${targetName}`,
            `references the components document${upstream.length === 1 ? '' : 's'} of ${upstream.join(', ')}, and its ` +
                `effective dependsOn does not name "${UPSTREAM_COMPONENTS}" — so nx may render it before ` +
                `${upstream.length === 1 ? 'that document exists' : 'those documents exist'}, and generation fails closed ` +
                'intermittently, mostly in CI.',
            `In ${where}, set targets.${targetName}.dependsOn to ${line}${replaces}.`,
        );
    }

    /** The components-publishing libraries `name` reaches through the dependency graph, itself excluded. */
    private librariesUpstreamOf(name: string, libraries: ReadonlySet<string>): string[] {
        const found = new Set<string>();
        const seen = new Set<string>([name]);
        const queue: string[] = [name];
        while (queue.length > 0) {
            const current = queue.shift()!;
            for (const dependency of this.dependencies[current] ?? []) {
                if (seen.has(dependency.target)) continue;
                seen.add(dependency.target);
                if (libraries.has(dependency.target)) found.add(dependency.target);
                queue.push(dependency.target);
            }
        }
        return [...found].sort();
    }

    /** Whether `target` dependsOn `^openapi-components-generate`, in either of nx's spellings. */
    private namesUpstream(target: TargetConfiguration): boolean {
        return (target.dependsOn ?? []).some((entry: DependsOnEntry) => {
            if (typeof entry === 'string') return entry === UPSTREAM_COMPONENTS;
            return entry.target === COMPONENTS_TARGET && entry.dependencies === true;
        });
    }
}
