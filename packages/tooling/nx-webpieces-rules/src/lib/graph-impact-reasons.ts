/**
 * WHY nx put each project into the affected set (#1264): the Impact view never claims a reason the
 * graph cannot show.
 *
 * `nx show projects --affected` answers WHICH projects build; it does not say why. Painting every
 * affected project that owns no changed file as "dependent: uses a changed project" was false for the
 * projects nx marked through an IMPLICIT touch — a `{workspaceRoot}/...` target input matching a
 * changed file — or through a ROOT FILE (a lockfile, package.json, tsconfig.base.json, nx.json). Those
 * projects use no changed project, so the graph around them shows nothing changed and the view looked
 * broken.
 *
 * So every affected project is classified by nx's OWN locators — the exact functions `filterAffected`
 * runs (nx/src/project-graph/affected/affected-project-graph.js) — never a re-derivation of them:
 *
 * | class | nx locator | what the view says |
 * |---|---|---|
 * | changed | `getTouchedProjects` (workspace-projects) | the changed files it owns |
 * | root-file touched | `nx.json` via `getImplicitlyTouchedProjects`; lockfile, package.json and tsconfig.base.json via the js plugin's locators; a deleted project config via `getTouchedProjectsFromProjectGlobChanges` | the root file, and which locator |
 * | implicitly touched | `getImplicitlyTouchedProjects` (a `{workspaceRoot}` input glob) | the target, the glob, and the changed file it matched |
 * | dependent | none: reached from one of the above over nx's REVERSED dependency edges, exactly as `filterAffectedProjects` walks them | the edge path to the nearest one (`a -> b -> c`) |
 * | unexplained | — | nx marked it and nothing here explains it; said out loud, never guessed |
 *
 * A project with several reasons gets the first class in that table's order (changed, root-file,
 * implicit, dependent). The locators are loaded from the WORKSPACE's own nx (the one that produced the
 * affected set), resolved the way node resolves it from the workspace root. When they cannot be
 * loaded, every affected project is "unexplained" with the load error as its reason — never a
 * dependent.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { NxJsonConfiguration, ProjectGraph, ProjectGraphProjectNode, TargetConfiguration } from '@nx/devkit';
import type { FileChange } from 'nx/src/project-graph/file-utils';
import type { InputDefinition } from 'nx/src/config/workspace-json-project-json';
import type { PackageJson } from 'nx/src/utils/package-json';
import type { TouchedProjectLocator } from 'nx/src/project-graph/affected/affected-project-graph-models';
import type * as FileUtils from 'nx/src/project-graph/file-utils';
import type * as NxJsonModule from 'nx/src/config/nx-json';
import type * as WorkspaceProjects from 'nx/src/project-graph/affected/locators/workspace-projects';
import type * as ProjectGlobChanges from 'nx/src/project-graph/affected/locators/project-glob-changes';
import type * as LockFileChanges from 'nx/src/plugins/js/project-graph/affected/lock-file-changes';
import type * as NpmPackages from 'nx/src/plugins/js/project-graph/affected/npm-packages';
import type * as TsConfigChanges from 'nx/src/plugins/js/project-graph/affected/tsconfig-json-changes';

/** The class a project's colour and click explanation come from. Values are the page's status keys. */
export enum AffectedClass {
    CHANGED = 'touched',
    DEPENDENT = 'dependent',
    IMPLICIT = 'implicit',
    ROOT_FILE = 'rootFile',
    UNEXPLAINED = 'unexplained',
}

/** nx's own nx.json implicit: a change to it marks every project. */
const NX_JSON = 'nx.json';

/** Why one affected project is in the build. Exactly one per affected project. */
export class AffectedReason {
    constructor(
        /** The node id (project name). */
        public readonly project: string,
        public readonly kind: AffectedClass,
        /** CHANGED: every changed file it owns. IMPLICIT / ROOT_FILE: the changed file that matched. */
        public readonly files: string[],
        /** DEPENDENT: `[project, …, the nearest changed or touched project]`, following dependency edges. */
        public readonly path: string[],
        /** IMPLICIT: the target whose inputs matched. */
        public readonly target: string,
        /** IMPLICIT: the input glob as written, e.g. `{workspaceRoot}/libs/shared/wiring.ts`. */
        public readonly input: string,
        /** One sentence for the click panel. */
        public readonly detail: string,
    ) {}
}

/** The six locators `filterAffected` runs, as functions. Injected so specs pass nx's own imports. */
export class NxAffectedLocators {
    constructor(
        public readonly touched: TouchedProjectLocator,
        public readonly implicit: TouchedProjectLocator,
        public readonly projectGlobs: TouchedProjectLocator,
        public readonly lockFile: TouchedProjectLocator,
        public readonly npmPackages: TouchedProjectLocator,
        public readonly tsConfig: TouchedProjectLocator,
    ) {}
}

/** One root-file locator and the words that name it. */
class RootFileLocator {
    constructor(
        public readonly locate: TouchedProjectLocator,
        public readonly what: string,
    ) {}
}

/** Everything the classification reads; built from the workspace's nx, or by hand in a spec. */
export class AffectedInputs {
    constructor(
        public readonly graph: ProjectGraph,
        public readonly nxJson: NxJsonConfiguration,
        public readonly packageJson: PackageJson,
        public readonly changes: FileChange[],
        /** nx's affected set (project names), from `nx show projects --affected`. */
        public readonly affected: string[],
    ) {}
}

/** The classification of one scan. */
export class AffectedClassification {
    constructor(
        /** One per affected project, sorted by project. */
        public readonly reasons: AffectedReason[],
        /** Changed files no project owns (sorted): the workspace-global inputs. */
        public readonly globalFiles: string[],
    ) {}

    of(kind: AffectedClass): string[] {
        return this.reasons
            .filter((reason: AffectedReason): boolean => reason.kind === kind)
            .map((reason: AffectedReason): string => reason.project);
    }
}

/** Classifies an affected set with nx's own locators. Pure given its inputs; spawns nothing itself. */
export class AffectedClassifier {
    constructor(private readonly locators: NxAffectedLocators) {}

    async classify(inputs: AffectedInputs): Promise<AffectedClassification> {
        const affected = new Set<string>(inputs.affected);
        const seeds = new Map<string, AffectedReason>();
        const owned = await this.owned(inputs);
        for (const project of owned.keys()) {
            const files = owned.get(project) as string[];
            const detail = `owns ${files.length} changed file${files.length === 1 ? '' : 's'}`;
            this.seed(seeds, affected, this.reason(project, AffectedClass.CHANGED, files, [], '', '', detail));
        }
        const external = new Map<string, AffectedReason>();
        await this.rootFiles(inputs, affected, seeds, external);
        await this.implicit(inputs, affected, seeds);
        const reasons = this.dependents(inputs.graph, affected, seeds, external);
        const globalFiles: string[] = [];
        for (const change of inputs.changes)
            if (!this.isOwned(owned, change.file)) globalFiles.push(change.file);
        return new AffectedClassification(
            reasons.sort((a: AffectedReason, b: AffectedReason): number => a.project.localeCompare(b.project)),
            globalFiles.sort(),
        );
    }

    private isOwned(owned: Map<string, string[]>, file: string): boolean {
        for (const files of owned.values()) if (files.includes(file)) return true;
        return false;
    }

    /** project → the changed files it owns, by nx's own file → project locator. */
    private async owned(inputs: AffectedInputs): Promise<Map<string, string[]>> {
        const owned = new Map<string, string[]>();
        for (const change of inputs.changes) {
            for (const project of await this.locators.touched([change], inputs.graph.nodes)) {
                const files = owned.get(project) ?? [];
                if (!files.includes(change.file)) files.push(change.file);
                owned.set(project, files);
            }
        }
        return owned;
    }

    /**
     * nx.json, the lockfile, package.json, tsconfig.base.json and a deleted project config. A locator
     * that answers even with NO change (nx.json's own `projectsAffectedByDependencyUpdates` list) is
     * named as that configuration, never as a file.
     */
    private async rootFiles(
        inputs: AffectedInputs,
        affected: Set<string>,
        seeds: Map<string, AffectedReason>,
        external: Map<string, AffectedReason>,
    ): Promise<void> {
        const nxJsonChange = inputs.changes.find((change: FileChange): boolean => change.file === NX_JSON);
        if (nxJsonChange !== undefined) {
            const marked = await this.locators.implicit([nxJsonChange], inputs.graph.nodes, inputs.nxJson);
            for (const project of marked)
                this.seed(seeds, affected, this.reason(project, AffectedClass.ROOT_FILE, [NX_JSON], [], '', '', 'nx.json changed: nx marks every project'));
        }
        for (const locator of this.rootFileLocators()) {
            // Probe file by file only when the locator marks anything for the whole change set.
            if ((await this.run(locator.locate, inputs.changes, inputs)).length === 0) continue;
            const baseline = new Set<string>(await this.run(locator.locate, [], inputs));
            for (const change of inputs.changes) {
                for (const name of await this.run(locator.locate, [change], inputs)) {
                    if (baseline.has(name)) continue;
                    const reason = this.reason(name, AffectedClass.ROOT_FILE, [change.file], [], '', '', `${change.file} changed (nx ${locator.what})`);
                    if (inputs.graph.nodes[name] !== undefined) this.seed(seeds, affected, reason);
                    else if (!external.has(name)) external.set(name, reason);
                }
            }
            for (const name of baseline)
                this.seed(seeds, affected, this.reason(name, AffectedClass.ROOT_FILE, [], [], '', '', `nx.json's own configuration marks it (nx ${locator.what})`));
        }
        // All-or-nothing in nx (a deleted project config marks every project), so it is asked once.
        for (const name of await this.run(this.locators.projectGlobs, inputs.changes, inputs))
            this.seed(seeds, affected, this.reason(name, AffectedClass.ROOT_FILE, [], [], '', '', 'a project configuration file was deleted: nx marks every project'));
    }

    private rootFileLocators(): RootFileLocator[] {
        return [
            new RootFileLocator(this.locators.lockFile, 'lockfile changes'),
            new RootFileLocator(this.locators.npmPackages, 'package.json dependency changes'),
            new RootFileLocator(this.locators.tsConfig, 'root tsconfig changes'),
        ];
    }

    private async run(locate: TouchedProjectLocator, changes: FileChange[], inputs: AffectedInputs): Promise<string[]> {
        return locate(changes, inputs.graph.nodes, inputs.nxJson, inputs.packageJson, inputs.graph);
    }

    /** `{workspaceRoot}` input globs: which target, which glob, which changed file. */
    private async implicit(inputs: AffectedInputs, affected: Set<string>, seeds: Map<string, AffectedReason>): Promise<void> {
        const changes = inputs.changes.filter((change: FileChange): boolean => change.file !== NX_JSON);
        if (changes.length === 0) return;
        for (const project of await this.locators.implicit(changes, inputs.graph.nodes, inputs.nxJson)) {
            const node = inputs.graph.nodes[project];
            if (seeds.has(project) || !affected.has(project) || node === undefined) continue;
            const explained = await this.explainImplicit(node, changes, inputs.nxJson);
            seeds.set(
                project,
                explained ?? this.reason(project, AffectedClass.IMPLICIT, [], [], '', '', 'a {workspaceRoot} target input matched a changed file'),
            );
        }
    }

    /**
     * Which target, input and file: each candidate input is handed to nx's OWN implicit locator, alone,
     * on a copy of the project carrying only that target, so the matcher is always nx's. Named inputs
     * are opened (nx.json's merged with the project's, as the locator merges them).
     */
    private async explainImplicit(
        node: ProjectGraphProjectNode,
        changes: FileChange[],
        nxJson: NxJsonConfiguration,
    ): Promise<AffectedReason | null> {
        const named: Record<string, (string | InputDefinition)[]> = { ...(nxJson.namedInputs ?? {}), ...(node.data.namedInputs ?? {}) };
        const bare: NxJsonConfiguration = { ...nxJson, namedInputs: {} };
        const matching: FileChange[] = [];
        for (const change of changes)
            if ((await this.locators.implicit([change], { [node.name]: node }, nxJson)).includes(node.name)) matching.push(change);
        for (const [target, config] of Object.entries(node.data.targets ?? {})) {
            for (const input of this.leaves(config.inputs ?? [], named, new Set<string>())) {
                const probe = this.probe(node, target, config, input);
                for (const change of matching) {
                    const hit = await this.locators.implicit([change], { [node.name]: probe }, bare);
                    if (!hit.includes(node.name)) continue;
                    const glob = typeof input === 'string' ? input : this.fileset(input);
                    return this.reason(node.name, AffectedClass.IMPLICIT, [change.file], [], target, glob, `${target} input ${glob} matched ${change.file}`);
                }
            }
        }
        return null;
    }

    /** Every input, with named inputs opened (cycle-safe). */
    private leaves(
        inputs: (string | InputDefinition)[],
        named: Record<string, (string | InputDefinition)[]>,
        open: Set<string>,
    ): (string | InputDefinition)[] {
        const out: (string | InputDefinition)[] = [];
        for (const input of inputs) {
            if (typeof input !== 'string' || named[input] === undefined) {
                out.push(input);
                continue;
            }
            if (open.has(input)) continue;
            open.add(input);
            out.push(...this.leaves(named[input], named, open));
        }
        return out;
    }

    private fileset(input: InputDefinition): string {
        return 'fileset' in input && typeof input.fileset === 'string' ? input.fileset : JSON.stringify(input);
    }

    private probe(
        node: ProjectGraphProjectNode,
        target: string,
        config: TargetConfiguration,
        input: string | InputDefinition,
    ): ProjectGraphProjectNode {
        return { ...node, data: { ...node.data, namedInputs: {}, targets: { [target]: { ...config, inputs: [input] } } } };
    }

    /**
     * Dependents: a breadth-first walk over the REVERSED dependency edges from every changed and
     * touched project (and every npm package a root file touched), the walk nx's own
     * `filterAffectedProjects` does — so the first seed reached is the NEAREST one. A project one edge
     * from a touched npm package is root-file touched itself ("uses npm:x: package.json changed").
     */
    private dependents(
        graph: ProjectGraph,
        affected: Set<string>,
        seeds: Map<string, AffectedReason>,
        external: Map<string, AffectedReason>,
    ): AffectedReason[] {
        const next = this.nearest(graph, [...seeds.keys(), ...external.keys()]);
        for (const project of next.keys()) {
            const hop = next.get(project) as string;
            const viaPackage = external.get(hop);
            if (viaPackage === undefined) continue;
            this.seed(seeds, affected, this.reason(project, AffectedClass.ROOT_FILE, viaPackage.files, [project, hop], '', '', `uses ${hop}: ${viaPackage.detail}`));
        }
        const reasons = [...seeds.values()];
        for (const project of [...affected].sort()) {
            if (seeds.has(project) || graph.nodes[project] === undefined) continue;
            reasons.push(next.has(project) ? this.dependent(project, next, seeds) : this.unexplained(project));
        }
        return reasons;
    }

    /** For each project reachable from `starts` over reversed edges, the next hop toward the nearest start. */
    private nearest(graph: ProjectGraph, starts: string[]): Map<string, string> {
        const users = new Map<string, string[]>();
        for (const [source, deps] of Object.entries(graph.dependencies ?? {}))
            for (const dep of deps) users.set(dep.target, [...(users.get(dep.target) ?? []), source]);
        const next = new Map<string, string>();
        const queue = [...starts];
        const seen = new Set<string>(queue);
        for (let index = 0; index < queue.length; index++) {
            for (const user of users.get(queue[index]) ?? []) {
                if (seen.has(user)) continue;
                seen.add(user);
                next.set(user, queue[index]);
                queue.push(user);
            }
        }
        return next;
    }

    private dependent(project: string, next: Map<string, string>, seeds: Map<string, AffectedReason>): AffectedReason {
        const route = [project];
        let at = project;
        while (!seeds.has(at) && next.has(at)) {
            at = next.get(at) as string;
            route.push(at);
        }
        const end = seeds.get(at);
        const what = end?.kind === AffectedClass.CHANGED ? 'a changed project' : 'a touched project';
        return this.reason(project, AffectedClass.DEPENDENT, [], route, '', '', `uses ${what}: ${route.join(' -> ')}`);
    }

    unexplained(project: string, why = "nx marked it affected; none of nx's locators run here explains why"): AffectedReason {
        return this.reason(project, AffectedClass.UNEXPLAINED, [], [], '', '', why);
    }

    /** First reason wins (changed, root-file, implicit, dependent); only affected projects count. */
    private seed(seeds: Map<string, AffectedReason>, affected: Set<string>, reason: AffectedReason): void {
        if (!seeds.has(reason.project) && affected.has(reason.project)) seeds.set(reason.project, reason);
    }

    private reason(
        project: string,
        kind: AffectedClass,
        files: string[],
        route: string[],
        target: string,
        input: string,
        detail: string,
    ): AffectedReason {
        return new AffectedReason(project, kind, files, route, target, input, detail);
    }
}

/** The `nxArgs` shape `calculateFileChanges` reads: a base and no head (the working tree). */
class AffectedBase {
    constructor(public readonly base: string) {}
}

/** The workspace's own nx, loaded the way node resolves it from the workspace root. */
export class WorkspaceNx {
    constructor(private readonly workspaceRoot: string) {}

    locators(): NxAffectedLocators {
        const workspace = this.load<typeof WorkspaceProjects>('nx/src/project-graph/affected/locators/workspace-projects');
        const globs = this.load<typeof ProjectGlobChanges>('nx/src/project-graph/affected/locators/project-glob-changes');
        const lock = this.load<typeof LockFileChanges>('nx/src/plugins/js/project-graph/affected/lock-file-changes');
        const npm = this.load<typeof NpmPackages>('nx/src/plugins/js/project-graph/affected/npm-packages');
        const ts = this.load<typeof TsConfigChanges>('nx/src/plugins/js/project-graph/affected/tsconfig-json-changes');
        return new NxAffectedLocators(
            workspace.getTouchedProjects,
            workspace.getImplicitlyTouchedProjects,
            globs.getTouchedProjectsFromProjectGlobChanges,
            lock.getTouchedProjectsFromLockFile as TouchedProjectLocator,
            npm.getTouchedNpmPackages,
            ts.getTouchedProjectsFromTsConfig,
        );
    }

    /** nx's own FileChange list: base → working tree (no head), as `nx affected` builds it. */
    fileChanges(files: string[], base: string): FileChange[] {
        const utils = this.load<typeof FileUtils>('nx/src/project-graph/file-utils');
        return utils.calculateFileChanges(files, new AffectedBase(base), (file: string, revision: string | void): string =>
            this.readAt(file, revision),
        );
    }

    nxJson(): NxJsonConfiguration {
        return this.load<typeof NxJsonModule>('nx/src/config/nx-json').readNxJson(this.workspaceRoot);
    }

    packageJson(): PackageJson {
        return this.load<typeof FileUtils>('nx/src/project-graph/file-utils').readPackageJson(this.workspaceRoot) as PackageJson;
    }

    /** A file at `revision`, or in the working tree with none; '' when it does not exist there. */
    private readAt(file: string, revision: string | void): string {
        if (typeof revision === 'string' && revision !== '') {
            const shown = spawnSync('git', ['show', `${revision}:${file}`], {
                cwd: this.workspaceRoot,
                encoding: 'utf8',
                stdio: 'pipe',
                maxBuffer: 64 * 1024 * 1024,
            });
            return shown.status === 0 ? shown.stdout : '';
        }
        const full = path.join(this.workspaceRoot, file);
        return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    }

    private load<T>(request: string): T {
        // webpieces-disable no-any-unknown -- a module loaded by path is untyped until the type-only import names it
        const loaded: unknown = require(require.resolve(request, { paths: [this.workspaceRoot] }));
        return loaded as T;
    }
}
