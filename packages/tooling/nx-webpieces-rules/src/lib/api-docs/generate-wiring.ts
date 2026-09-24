/**
 * The wiring a project opting into generated API documents needs, checked by `validate-nx-wiring`
 * on nx's RESOLVED project graph (#1023, correcting #1021). It is nx's own documented codegen shape
 * (https://nx.dev/blog/dotnet-openapi-type-safety):
 *
 * ```
 * <api-lib>:build             @nx/js:tsc → its outputPath         (unchanged — still named `build`)
 * <api-lib>:openapi-generate  dependsOn ["build"] → writes into build's outputPath
 * nx.json targetDefaults      every build / test default a dependent runs: dependsOn "^openapi-generate"
 * ```
 *
 * Why the api library's tsc target must stay `build`: `@nx/js:tsc` decides whether each dependency is
 * BUILDABLE by looking for a target with the SAME NAME as the one running (nx 22,
 * `buildable-libs-utils.js` `calculateProjectDependencies`). A library whose tsc target is renamed
 * `compile` sees every `build`-only dependency as non-buildable, pulls its SOURCE into the compile,
 * and tsc fails with TS6059 "rootDir is expected to contain all source files" (nrwl/nx#18257, closed
 * as outdated, never fixed). #1021's `compile` → `openapi-generate` → noop-`build` split hit exactly
 * that in the first real consumer, so it is no longer the design.
 *
 * Why the dependents carry `^openapi-generate`: nx `dependsOn` only points BACKWARD, so generation
 * (which must run AFTER tsc, whose cleanup wipes the outputPath) cannot be hung off the library's own
 * `build`. ONE repo-wide `nx.json` line per targetDefaults entry pulls it in instead — nx skips a
 * dependency that has no `openapi-generate` and keeps walking its dependencies, so a project with no
 * generating library upstream is unaffected, and a transitive dependent is reached through the
 * projects between. A server spec that boots the MCP server reads the library's generated tool
 * catalogs out of its build output, which is why `test` needs it as much as `build` does.
 */

import type { ProjectConfiguration, TargetConfiguration, TargetDependencyConfig } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { Option, RuleFailError, matchesAnyGlob, renderRuleFailForHuman } from '@webpieces/rules-config';
import { GENERATE_DOCS_SITE_TAG, GENERATE_OPENAPI_TAG } from '../../generate-targets';

/** One wiring defect, and the exact edit that fixes it. Data-only. */
export class GenerateWiringProblem {
    constructor(
        /** The project — or, for an nx.json edit, every project that edit fixes. */
        readonly project: string,
        readonly problem: string,
        readonly cure: string,
    ) {}
}

/** The one field of an nx graph dependency this check reads. Data-only. */
export class ProjectDependency {
    constructor(readonly target: string) {}
}

/** One `nx.json` targetDefaults entry — only the field this check reads. Data-only. */
export class TargetDefault {
    constructor(readonly dependsOn: readonly DependsOnEntry[] | undefined) {}
}

/**
 * Which targets each project's OWN project.json declares a `dependsOn` for. nx does not merge
 * `dependsOn` — a project-level one REPLACES the targetDefaults one — so this decides whether the
 * cure is an nx.json edit or a project.json edit. Data-only.
 */
export class DeclaredDependsOn {
    constructor(readonly byProject: Readonly<Record<string, readonly string[]>>) {}

    declares(project: string, target: string): boolean {
        return (this.byProject[project] ?? []).includes(target);
    }
}

type DependsOnEntry = string | TargetDependencyConfig;

/** The fields of a project.json / nx.json this check reads, as they sit in the file. */
type RawTarget = { dependsOn?: DependsOnEntry[] };
type RawTargets = { targets?: Record<string, RawTarget> };
type RawNxJson = { targetDefaults?: Record<string, RawTarget> };

/** Reads the two on-disk facts the resolved graph has already merged away. */
export class WiringSourceReader {
    constructor(private readonly workspaceRoot: string) {}

    /** `nx.json` targetDefaults, as written. A missing or unreadable nx.json has none. */
    targetDefaults(): Record<string, TargetDefault> {
        const raw = this.readJson(path.join(this.workspaceRoot, 'nx.json')) as RawNxJson | undefined;
        const defaults: Record<string, TargetDefault> = {};
        for (const [key, entry] of Object.entries(raw?.targetDefaults ?? {})) {
            defaults[key] = new TargetDefault(entry.dependsOn);
        }
        return defaults;
    }

    /** Which targets each project's own project.json declares `dependsOn` for. */
    declaredDependsOn(projects: Readonly<Record<string, ProjectConfiguration>>): DeclaredDependsOn {
        const byProject: Record<string, string[]> = {};
        for (const [name, project] of Object.entries(projects)) {
            const raw = this.readJson(path.join(this.workspaceRoot, project.root, 'project.json')) as RawTargets | undefined;
            const targets = raw?.targets ?? {};
            byProject[name] = Object.keys(targets).filter((target: string) => targets[target]!.dependsOn !== undefined);
        }
        return new DeclaredDependsOn(byProject);
    }

    /** A JSON file's contents, or undefined when it is absent — a project inferred from package.json has no project.json. */
    private readJson(file: string): RawTargets | RawNxJson | undefined {
        if (!fs.existsSync(file)) return undefined;
        return JSON.parse(fs.readFileSync(file, 'utf8')) as RawTargets | RawNxJson;
    }
}

/** The executors the plugin infers from a tag — a project.json naming one by hand is a second opt-in. */
const INFERRED_EXECUTORS: readonly string[] = [
    '@webpieces/nx-webpieces-rules:openapi-generate',
    '@webpieces/nx-webpieces-rules:docs-generate',
];

/** The tsc target an api library keeps, and `openapi-generate` dependsOn. */
const BUILD_TARGET = 'build';
/** The targets a dependent runs that must pull generation in. */
const DEPENDENT_TARGETS: readonly string[] = ['build', 'test'];
const UPSTREAM_GENERATE = `^${GeneratedApiDocsLayout.OPENAPI_TARGET}`;

/** One missing `^openapi-generate`, before grouping by the edit that fixes it. Data-only. */
class MissingGenerate {
    constructor(
        readonly project: string,
        readonly target: string,
        readonly upstream: readonly string[],
        /** Where the fix goes — the grouping key. */
        readonly where: string,
        readonly cure: string,
    ) {}
}

export class GenerateWiring {
    constructor(
        /** nx's RESOLVED project configurations — targetDefaults and inferred targets merged in. */
        private readonly projects: Readonly<Record<string, ProjectConfiguration>>,
        /** The project graph's dependencies, by source project. */
        private readonly dependencies: Readonly<Record<string, readonly ProjectDependency[]>>,
        /** `nx.json` targetDefaults, as written — to name the key a cure edits. */
        private readonly targetDefaults: Readonly<Record<string, TargetDefault>>,
        /** Which targets each project.json declares its own dependsOn for. */
        private readonly declared: DeclaredDependsOn,
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
            'A project generating API documents, or one depending on it, is not wired so that build and test generate them:\n' +
                problems.map((each: GenerateWiringProblem) => `  ${each.project}: ${each.problem}`).join('\n'),
            undefined,
            undefined,
            problems.map((each: GenerateWiringProblem) => new Option(each.cure, true)),
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
                    `${name}: add "${targetName === GeneratedApiDocsLayout.DOCS_TARGET ? GENERATE_DOCS_SITE_TAG : GENERATE_OPENAPI_TAG}" ` +
                        `to "tags" in ${project.root}/project.json and delete the "executor" line of targets.${targetName}.`,
                ));
            }
        }
        return problems;
    }

    /** (a) `openapi-generate` dependsOn exactly the project's own `build`, the tsc target. */
    private shapeOf(name: string): GenerateWiringProblem[] {
        const project = this.projects[name]!;
        const where = `${project.root}/project.json`;
        const lookup = new GeneratedApiDocsLayout(project.root, name, project.targets ?? {}).outputTarget();
        if (lookup.found === undefined) {
            return [new GenerateWiringProblem(name, lookup.problem!.problem, `${name}: ${lookup.problem!.cure}`)];
        }
        if (lookup.found.targetName === BUILD_TARGET) return [];
        const other = lookup.found.targetName;
        return [new GenerateWiringProblem(
            name,
            `${name}:${GeneratedApiDocsLayout.OPENAPI_TARGET} dependsOn "${other}", and must dependsOn "${BUILD_TARGET}" — ` +
                `the api library's @nx/js:tsc target keeps the name build. @nx/js:tsc treats a dependency as buildable ` +
                `only when it has a target of the SAME name as the one running, so a tsc target renamed "${other}" ` +
                'compiles every build-only dependency from SOURCE and fails with TS6059 (nrwl/nx#18257).',
            `${name}: in ${where}, name the @nx/js:tsc target "${BUILD_TARGET}" again (delete any nx:noop "build" that ` +
                `wrapped it) and set targets.${GeneratedApiDocsLayout.OPENAPI_TARGET}.dependsOn to ["${BUILD_TARGET}"]. ` +
                `Dependents pull generation in with "${UPSTREAM_GENERATE}" in nx.json targetDefaults.`,
        )];
    }

    /**
     * (b) Every project that depends — transitively — on a generating library has `^openapi-generate`
     * in the EFFECTIVE dependsOn of its `build` and `test`. One problem per EDIT, listing every project
     * that edit fixes: an nx.json targetDefaults key usually covers the whole repo at once.
     */
    private dependentsOf(generating: ReadonlySet<string>): GenerateWiringProblem[] {
        const byEdit = new Map<string, MissingGenerate[]>();
        for (const name of Object.keys(this.projects).sort()) {
            const upstream = this.generatingUpstreamOf(name, generating);
            if (upstream.length === 0) continue;
            for (const targetName of DEPENDENT_TARGETS) {
                const target = this.projects[name]!.targets?.[targetName];
                if (target === undefined || this.names(target, UPSTREAM_GENERATE)) continue;
                const missing = this.missingFor(name, targetName, target, upstream);
                const group = byEdit.get(missing.where) ?? [];
                group.push(missing);
                byEdit.set(missing.where, group);
            }
        }
        const problems: GenerateWiringProblem[] = [];
        for (const group of byEdit.values()) {
            const first = group[0]!;
            const who = group.map((each: MissingGenerate) => `${each.project}:${each.target}`).join(', ');
            const libraries = [...new Set(group.flatMap((each: MissingGenerate) => [...each.upstream]))].sort();
            problems.push(new GenerateWiringProblem(
                who,
                `depends on ${libraries.join(', ')}, which generate${libraries.length === 1 ? 's' : ''} API documents and MCP ` +
                    `tool catalogs into ${libraries.length === 1 ? 'its' : 'their'} build output, and the effective dependsOn ` +
                    `does not name "${UPSTREAM_GENERATE}" — so nothing generates them before this runs (a spec that boots ` +
                    'the MCP server would read catalogs that were never written, or stale ones).',
                first.cure,
            ));
        }
        return problems;
    }

    /** The generating libraries `name` reaches through the dependency graph, itself excluded. */
    private generatingUpstreamOf(name: string, generating: ReadonlySet<string>): string[] {
        const found = new Set<string>();
        const seen = new Set<string>([name]);
        const queue: string[] = [name];
        while (queue.length > 0) {
            const current = queue.shift()!;
            for (const dependency of this.dependencies[current] ?? []) {
                if (seen.has(dependency.target)) continue;
                seen.add(dependency.target);
                if (generating.has(dependency.target)) found.add(dependency.target);
                queue.push(dependency.target);
            }
        }
        return [...found].sort();
    }

    /** Where the missing `^openapi-generate` goes: the project.json that overrides, or the nx.json key. */
    private missingFor(
        name: string,
        targetName: string,
        target: TargetConfiguration,
        upstream: readonly string[],
    ): MissingGenerate {
        const effective = (target.dependsOn ?? []) as DependsOnEntry[];
        if (this.declared.declares(name, targetName)) {
            const where = `${this.projects[name]!.root}/project.json`;
            return new MissingGenerate(
                name, targetName, upstream, `${where}#${targetName}`,
                `In ${where}, targets.${targetName}.dependsOn REPLACES nx.json's (nx does not merge dependsOn), so add ` +
                    `"${UPSTREAM_GENERATE}" there: "dependsOn": ${this.render([...effective, UPSTREAM_GENERATE])}`,
            );
        }
        const key = this.defaultKeyFor(targetName, target.executor);
        const existing = key === undefined ? [] : [...(this.targetDefaults[key]!.dependsOn ?? [])];
        const editKey = key ?? targetName;
        const line = `"${editKey}": { "dependsOn": ${this.render([...existing, UPSTREAM_GENERATE])} }`;
        return new MissingGenerate(
            name, targetName, upstream, `nx.json#${editKey}`,
            key === undefined
                ? `In nx.json, add the targetDefaults entry ${line} — no targetDefaults key governs ${targetName} yet.`
                : `In nx.json, set targetDefaults["${editKey}"].dependsOn so the entry reads ${line} ` +
                    '(keep its other fields).',
        );
    }

    /**
     * The targetDefaults key nx reads for this target — nx's own precedence
     * (`readTargetDefaultsForTarget`): the EXECUTOR key when one exists, else the target NAME, else the
     * longest glob key matching the name.
     */
    private defaultKeyFor(targetName: string, executor: string | undefined): string | undefined {
        if (executor !== undefined && this.targetDefaults[executor] !== undefined) return executor;
        if (this.targetDefaults[targetName] !== undefined) return targetName;
        let best: string | undefined;
        for (const key of Object.keys(this.targetDefaults)) {
            if (!/[*?[\]{}!]/.test(key) || !matchesAnyGlob(targetName, [key])) continue;
            if (best === undefined || key.length > best.length) best = key;
        }
        return best;
    }

    private render(entries: readonly DependsOnEntry[]): string {
        return `[${entries.map((entry: DependsOnEntry) => JSON.stringify(entry)).join(', ')}]`;
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
