/**
 * Impact mode's data: what THIS BRANCH's build looks like, in three shades (plus untouched grey).
 *
 *  - BUILD INPUT is every transitive dependency of the affected set that is not itself affected:
 *    `ci` dependsOn `^build`, so they must exist as build output though their inputs did not change.
 *    nx restores them from cache when it has them and compiles them otherwise — which one happens is
 *    not knowable here, so nothing claims it. A pure downward walk over the graph's own edges.
 *
 *  - AFFECTED is `nx show projects --affected --base=<fork point> --json`, with NO `--head`, so
 *    uncommitted and untracked work counts. nx already gets right everything a hand-rolled diff gets
 *    wrong: lockfile and package.json changes resolved per project, root/global inputs, namedInputs,
 *    implicitDependencies, nested roots and deleted files. This uses its public CLI surface only, never
 *    nx internals.
 *  - TOUCHED is the subset of that set which OWNS a changed file, by nx's own file-to-project
 *    ownership (the project file map from `createProjectFileMapUsingProjectGraph`, public devkit API)
 *    — never a path-prefix guess. A project whose only change is a DELETED file is not in that map
 *    (the file is gone), so it shows as affected rather than touched.
 *
 * The base is the repo's existing merge-base computation (`DiffScope.detectBase` in rules-config:
 * `git merge-base HEAD origin/main`, falling back to `main`) — never NX_BASE/NX_HEAD, whose value
 * depends on whoever launched the process. The changed-file list is `DiffScope.getChangedFiles`, the
 * same base→working-tree diff (with untracked files) every code rule uses.
 *
 * The answer changes per branch, so it never goes into the committed dependencies.html or
 * dependencies.json (both stay byte-stable across branches). It goes into a SIDECAR,
 * `architecture/.impact/dependencies.impact.js`: a plain script setting one window global, loaded
 * with `<script src>` — the one way a page opened straight from disk (file://) can read a
 * neighbouring file. The directory carries its own `.gitignore` containing `*`, which ignores the
 * directory and everything in it, so a consumer repo needs no gitignore edit and the PR gate's
 * "build left nothing uncommitted" check never sees it.
 *
 * Both `architecture:generate` and `architecture:visualize` refresh it: the answer changes with the
 * branch, not with the architecture, so viewing the SAVED graph re-scans Impact against it without
 * regenerating anything else (#1158).
 *
 * Impact is a convenience. When nx or git cannot answer, NO sidecar is written (a stale one is
 * removed) and the page disables Impact with a one-line reason. It never fails generation.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createProjectFileMapUsingProjectGraph, createProjectGraphAsync } from '@nx/devkit';
import { DiffScope, ChangedFilesOptions } from '@webpieces/rules-config';
import type { EnhancedGraph } from './graph-sorter';
import { GraphNames } from './graph-names';
import { toError } from '../toError';

/** Relative to the architecture/ directory the page lives in; the page's `<script src>`. */
export const IMPACT_SIDECAR_DIR = '.impact';
export const IMPACT_SIDECAR_FILE = 'dependencies.impact.js';
export const IMPACT_SIDECAR_SRC = `${IMPACT_SIDECAR_DIR}/${IMPACT_SIDECAR_FILE}`;
/** The nx call is capped; a slow or wedged nx disables Impact instead of stalling generation. */
const NX_TIMEOUT_MS = 15000;

/** What the sidecar carries; the page reads it as `window.__WP_IMPACT__`. */
export class ImpactReport {
    constructor(
        public readonly available: boolean,
        public readonly reason: string,
        public readonly base: string,
        /** Affected AND owning a changed file (node ids). */
        public readonly touched: string[],
        /** Affected but owning no changed file (node ids): their ci re-runs. */
        public readonly affected: string[],
        /**
         * Transitive dependencies of the affected set that are NOT affected (node ids). `ci` dependsOn
         * `^build`, so they must exist as build output although their inputs did not change: nx
         * restores them from cache when it has them and compiles them otherwise. Which of the two
         * happens is not knowable here, so the page claims neither.
         */
        public readonly buildInputs: string[],
        public readonly changedFiles: number,
        /**
         * Transitive dependencies of the TOUCHED set that are not touched themselves (node ids): the
         * Filter popover's "Changed + what they use". ("Changed + what uses them" is touched +
         * affected, which nx already computed as the dependents whose tests re-run.)
         */
        public readonly dependencies: string[],
        /**
         * Changed files no project owns (repo-relative, sorted): workspace-global inputs such as
         * pnpm-lock.yaml. When nothing is touched they are WHY everything is affected, and the
         * legend names them. Empty when nx's file ownership was unavailable — then nothing is known.
         */
        public readonly globalFiles: string[],
    ) {}
}

/** A scan that could not produce an answer: no sidecar is written, only this reason printed. */
export class ImpactUnavailable {
    constructor(public readonly reason: string) {}
}

/** Runs the workspace's own nx CLI. Injected so specs never spawn nx. */
export class NxCli {
    /** stdout, or null when nx cannot be found, exits non-zero or exceeds the timeout. */
    run(workspaceRoot: string, args: string[], timeoutMs: number): string | null {
        const bin = this.binary(workspaceRoot);
        if (bin === null) return null;
        const result = spawnSync(process.execPath, [bin, ...args], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: 'pipe',
            maxBuffer: 16 * 1024 * 1024,
        });
        if (result.error !== undefined || result.status !== 0) return null;
        return result.stdout;
    }

    /** Resolved the way node would from the workspace, so a linked worktree finds its main tree's nx. */
    private binary(workspaceRoot: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a workspace without nx resolves nothing; that is an answer, not an error
        try {
            return require.resolve('nx/bin/nx.js', { paths: [workspaceRoot] });
        } catch (err: unknown) {
            const error = toError(err);
            void error; // no nx installed here — Impact is simply unavailable
            return null;
        }
    }
}

/** nx's own file → project ownership, from the public devkit file map. Injected for specs. */
export class ProjectFileOwners {
    async owners(): Promise<Map<string, string>> {
        const fileMap = await createProjectFileMapUsingProjectGraph(await createProjectGraphAsync());
        const owners = new Map<string, string>();
        for (const project of Object.keys(fileMap)) {
            for (const data of fileMap[project]) owners.set(data.file, project);
        }
        return owners;
    }
}

export class NxImpactScanner {
    private readonly names = new GraphNames();

    constructor(
        private readonly diffScope: DiffScope = new DiffScope(),
        private readonly nx: NxCli = new NxCli(),
        private readonly ownership: ProjectFileOwners = new ProjectFileOwners(),
    ) {}

    async scan(workspaceRoot: string, graph: EnhancedGraph): Promise<ImpactReport | ImpactUnavailable> {
        const base = this.diffScope.detectBase(workspaceRoot);
        if (base === null) return new ImpactUnavailable('no fork point: neither origin/main nor main resolves (or git is unavailable)');
        const json = this.nx.run(workspaceRoot, ['show', 'projects', '--affected', `--base=${base}`, '--json'], NX_TIMEOUT_MS);
        if (json === null) return new ImpactUnavailable(`nx show projects --affected failed or took over ${NX_TIMEOUT_MS / 1000}s`);
        const affectedSet = this.parse(json, graph);
        if (affectedSet === null) return new ImpactUnavailable('nx show projects --affected printed something other than a JSON list');
        const options = new ChangedFilesOptions();
        options.tsOnly = false;
        options.includeDeletions = true;
        const files = this.diffScope.getChangedFiles(workspaceRoot, base, undefined, options);
        const short = base.slice(0, 7);
        if (affectedSet.length === 0)
            return new ImpactReport(false, `nothing affected since the fork point ${short}`, short, [], [], [], files.length, [], []);
        const owners = await this.owners();
        const touched = this.touched(affectedSet, files, owners);
        const rest = affectedSet.filter((project: string): boolean => !touched.includes(project));
        const inputs = this.buildInputs(affectedSet, graph);
        return new ImpactReport(
            true,
            '',
            short,
            this.ids(touched),
            this.ids(rest),
            this.ids(inputs),
            files.length,
            this.ids(this.buildInputs(touched, graph)),
            this.globalFiles(files, owners),
        );
    }

    /** Changed files no project owns; none are claimed when ownership itself was unavailable. */
    globalFiles(files: string[], owners: Map<string, string>): string[] {
        if (owners.size === 0) return [];
        return files.filter((file: string): boolean => !owners.has(file)).sort();
    }

    /**
     * Every transitive dependency of `roots` that is not itself one of them: a pure downward walk over
     * the graph's own dependsOn edges, no nx call. Of the affected set these are the build inputs; of
     * the touched set, "what they use".
     */
    buildInputs(roots: string[], graph: EnhancedGraph): string[] {
        const inSet = new Set<string>(roots);
        const seen = new Set<string>(roots);
        const stack = [...roots];
        const inputs: string[] = [];
        while (stack.length > 0) {
            const project = stack.pop() as string;
            for (const dep of graph[project]?.dependsOn ?? []) {
                if (seen.has(dep)) continue;
                seen.add(dep);
                stack.push(dep);
                if (!inSet.has(dep) && graph[dep] !== undefined) inputs.push(dep);
            }
        }
        return inputs.sort();
    }

    /** Affected projects that own one of the changed files, by nx's own ownership. */
    touched(affected: string[], files: string[], owners: Map<string, string>): string[] {
        const owning = new Set<string>();
        for (const file of files) {
            const owner = owners.get(file);
            if (owner !== undefined) owning.add(owner);
        }
        return affected.filter((project: string): boolean => owning.has(project));
    }

    /** The JSON list, narrowed to projects the graph draws; null when it is not a list of names. */
    parse(json: string, graph: EnhancedGraph): string[] | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- untrusted CLI output; anything unparseable is reported as a reason
        try {
            // webpieces-disable no-any-unknown -- CLI JSON is untrusted until narrowed below
            const parsed: unknown = JSON.parse(json);
            if (!Array.isArray(parsed)) return null;
            return parsed
                .filter((name: unknown): name is string => typeof name === 'string' && graph[name] !== undefined)
                .sort();
        } catch (err: unknown) {
            const error = toError(err);
            void error; // not JSON — the caller reports it
            return null;
        }
    }

    /** Ownership failing is not fatal: the set then shows in one shade, all "affected". */
    private async owners(): Promise<Map<string, string>> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the second shade is optional
        try {
            return await this.ownership.owners();
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`⚠️  Impact: nx file ownership unavailable (${error.message}); showing one shade`);
            return new Map<string, string>();
        }
    }

    private ids(projects: string[]): string[] {
        return projects.map((project: string): string => this.names.getNodeId(project));
    }
}

/** Writes (or removes) the sidecar, self-ignored, beside architecture/dependencies.html. */
export class ImpactSidecar {
    /** Never throws: a sidecar that cannot be written just leaves Impact disabled on the page. */
    write(architectureDir: string, report: ImpactReport): string | null {
        const dir = path.join(architectureDir, IMPACT_SIDECAR_DIR);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- impact is optional; a write failure must never fail generation
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, '.gitignore'),
                '# Written by architecture:generate and architecture:visualize. Per-branch data: never commit it.\n*\n',
                'utf-8',
            );
            const file = path.join(dir, IMPACT_SIDECAR_FILE);
            fs.writeFileSync(file, this.script(report), 'utf-8');
            return file;
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`⚠️  Could not write the impact sidecar: ${error.message}`);
            return null;
        }
    }

    /** A stale sidecar from an earlier branch must never be shown as this branch's impact. */
    remove(architectureDir: string): void {
        fs.rmSync(path.join(architectureDir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE), { force: true });
    }

    script(report: ImpactReport): string {
        const json = JSON.stringify(report).replace(/</g, '\\u003c');
        return `// Generated by architecture:generate or architecture:visualize for one branch. Gitignored; do not commit.\nwindow.__WP_IMPACT__ = ${json};\n`;
    }
}

/** The generator's one call: scan, write, and report the result and its cost in one line. */
export class ImpactRefresh {
    constructor(
        private readonly scanner: NxImpactScanner = new NxImpactScanner(),
        private readonly sidecar: ImpactSidecar = new ImpactSidecar(),
    ) {}

    /** Never throws — Impact is optional, generation is not. */
    async run(architectureDir: string, workspaceRoot: string, graph: EnhancedGraph): Promise<string> {
        const started = Date.now();
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- impact is optional; any failure becomes a reason, never a failed generation
        try {
            const report = await this.scanner.scan(workspaceRoot, graph);
            const cost = `${Date.now() - started} ms`;
            if (report instanceof ImpactUnavailable) {
                this.sidecar.remove(architectureDir);
                return `ℹ️  Impact disabled, no sidecar written: ${report.reason} (${cost})`;
            }
            const file = this.sidecar.write(architectureDir, report);
            if (file === null) return `⚠️  Impact sidecar not written (${cost})`;
            if (!report.available) return `ℹ️  Impact disabled on the page: ${report.reason} (${cost})`;
            return (
                `✅ Impact vs ${report.base}: ${report.touched.length} touched · ${report.affected.length} affected · ` +
                `${report.buildInputs.length} build inputs, from ${report.changedFiles} changed file(s) (${cost}) → ${file}`
            );
        } catch (err: unknown) {
            const error = toError(err);
            return `⚠️  Impact skipped: ${error.message}`;
        }
    }
}
