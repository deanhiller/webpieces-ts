/**
 * Impact mode's data: what one COMPARISON's build looks like, in three shades (plus untouched grey).
 *
 * There are two comparisons, and only two (#1163). Both end at the WORKING TREE, so uncommitted and
 * untracked work counts in either:
 *
 *  - BRANCH, "Changed on this branch": the fork point (`DiffScope.detectBase` in rules-config:
 *    `git merge-base HEAD origin/main`, falling back to `main`) → working tree.
 *  - COMMIT, "Last commit": `HEAD^` → working tree. To see what another commit changed, check it out
 *    (`git checkout <hash>`) and run `pnpm arch:visualize`: nx computes `--affected` against the code
 *    that is actually on disk, so nothing here ever jumps to another commit.
 *
 * Which of them exist is decided by `ImpactScopeResolver` from where HEAD is. On `main` (by BRANCH
 * NAME, so a local main with unpushed commits still counts as main) and on a detached HEAD only the
 * last commit exists — the fork point IS HEAD there, so the branch comparison would always be empty.
 * On a feature branch with commits past its fork point both exist, the branch one first. On a FRESH
 * feature branch (fork point = HEAD) only the branch one exists: falling through to "last commit"
 * would show main's last PR as if it were the branch's own work.
 *
 * Per comparison:
 *  - BUILD INPUT is every transitive dependency of the affected set that is not itself affected:
 *    `ci` dependsOn `^build`, so they must exist as build output though their inputs did not change.
 *    nx restores them from cache when it has them and compiles them otherwise — which one happens is
 *    not knowable here, so nothing claims it. A pure downward walk over the graph's own edges.
 *  - AFFECTED is `nx show projects --affected --base=<the comparison's base> --json`, with NO
 *    `--head`, so uncommitted and untracked work counts. nx already gets right everything a
 *    hand-rolled diff gets wrong: lockfile and package.json changes resolved per project, root/global
 *    inputs, namedInputs, implicitDependencies, nested roots and deleted files. This uses its public
 *    CLI surface only, never nx internals, and never NX_BASE/NX_HEAD, whose value depends on whoever
 *    launched the process.
 *  - TOUCHED is the subset of that set which OWNS a changed file, by nx's own file-to-project
 *    ownership (the project file map from `createProjectFileMapUsingProjectGraph`, public devkit API)
 *    — never a path-prefix guess. The ownership map is computed ONCE and shared by every comparison.
 *    A project whose only change is a DELETED file is not in that map (the file is gone), so it shows
 *    as affected rather than touched. The changed-file list is `DiffScope.getChangedFiles`, the same
 *    base→working-tree diff (with untracked files) every code rule uses.
 *
 * The answer changes per checkout, so it never goes into the committed dependencies.html or
 * dependencies.json (both stay byte-stable). It goes into a SIDECAR,
 * `architecture/.impact/dependencies.impact.js`: a plain script setting one window global,
 * `window.__WP_IMPACT__ = { scans, defaultKind }`, loaded with `<script src>` — the one way a page
 * opened straight from disk (file://) can read a neighbouring file. The directory carries its own
 * `.gitignore` containing `*`, which ignores the directory and everything in it, so a consumer repo
 * needs no gitignore edit and the PR gate's "build left nothing uncommitted" check never sees it.
 *
 * `architecture:visualize` scans every comparison that exists. `architecture:generate` refreshes
 * ONLY the branch comparison (`GENERATE_IMPACT_KINDS`) and never scans the last commit; on main or a
 * detached HEAD that leaves nothing to write, so it removes the sidecar and the page says to run
 * `pnpm arch:visualize`.
 *
 * Impact is a convenience. When nx or git cannot answer any comparison, NO sidecar is written (a
 * stale one is removed) and the page disables Impact with a one-line reason. It never fails
 * generation.
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
/** Each nx call is capped; a slow or wedged nx disables that comparison instead of stalling generation. */
const NX_TIMEOUT_MS = 15000;
/** The branch whose name means "there is no branch comparison here, only the last commit". */
const MAIN_BRANCH = 'main';

export const NOTHING_CHANGED_ON_BRANCH = 'Nothing changed on this branch yet';
export const ROOT_COMMIT_REASON =
    "HEAD is the repository's first commit; there is no previous commit to compare against";
export const UNCOMMITTED_SUFFIX = ' + uncommitted changes';

/** Which of the two comparisons a scan answers. */
export enum ImpactKind {
    /** Fork point → working tree: "Changed on this branch". */
    BRANCH = 'branch',
    /** HEAD^ → working tree: "Last commit". */
    COMMIT = 'commit',
}

/** `architecture:visualize` scans every comparison that exists. */
export const VISUALIZE_IMPACT_KINDS: readonly ImpactKind[] = [ImpactKind.BRANCH, ImpactKind.COMMIT];
/** `architecture:generate` refreshes the branch comparison only and never scans the last commit. */
export const GENERATE_IMPACT_KINDS: readonly ImpactKind[] = [ImpactKind.BRANCH];

/** One scan as the sidecar carries it; the page reads `window.__WP_IMPACT__.scans`. */
export class ImpactReport {
    constructor(
        public readonly kind: ImpactKind,
        /** What the page says this scan compares, e.g. "Changed on this branch (since abc1234)". */
        public readonly label: string,
        /** The working tree had uncommitted or untracked changes (they count in the scan). */
        public readonly dirty: boolean,
        public readonly available: boolean,
        /** Why the scan is unavailable; for an available but EMPTY scan, the note the page shows. */
        public readonly reason: string,
        /** The base's short sha ('' when there is none). */
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
         * Filter popover's "Changed + dependencies". ("Changed + dependents" is touched + affected,
         * which nx already computed as the dependents whose tests re-run.)
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

/** The sidecar's one global: every scan, and the one the page shows first. */
export class ImpactSidecarData {
    constructor(
        public readonly scans: ImpactReport[],
        public readonly defaultKind: ImpactKind,
    ) {}
}

/** A scan (or a whole plan) that could not produce an answer. */
export class ImpactUnavailable {
    constructor(
        public readonly reason: string,
        public readonly label: string = 'Impact',
    ) {}
}

/** One comparison to scan. `base` is a full sha; null when it does not exist (`reason` says why). */
export class ImpactComparison {
    constructor(
        public readonly kind: ImpactKind,
        public readonly base: string | null,
        public readonly label: string,
        public readonly dirty: boolean,
        public readonly reason: string,
    ) {}
}

/** The comparisons that exist where HEAD is, and which one the page shows first. */
export class ImpactPlan {
    constructor(
        public readonly comparisons: ImpactComparison[],
        public readonly defaultKind: ImpactKind,
    ) {}
}

/** The few git facts the resolver needs. Injected so specs never spawn git. */
export class ImpactGit {
    /** The checked-out branch's short name; null on a detached HEAD (or without git). */
    branch(root: string): string | null {
        return this.run(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    }

    /** The full sha `ref` names; null when it does not resolve (e.g. `HEAD^` on the first commit). */
    sha(root: string, ref: string): string | null {
        return this.run(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    }

    /** `git status --porcelain` is non-empty: uncommitted or untracked work. */
    dirty(root: string): boolean {
        return (this.run(root, ['status', '--porcelain']) ?? '') !== '';
    }

    /** HEAD's subject line ('' when unknown). */
    subject(root: string): string {
        return this.run(root, ['log', '-1', '--format=%s', 'HEAD']) ?? '';
    }

    /** Trimmed stdout, or null on any failure. */
    private run(root: string, args: string[]): string | null {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
        if (result.error !== undefined || result.status !== 0) return null;
        return result.stdout.trim();
    }
}

/**
 * Decides which comparisons exist from where HEAD is (#1163):
 *
 * | where | comparisons | default |
 * |---|---|---|
 * | `main` (by branch NAME) | last commit | last commit |
 * | detached HEAD | last commit | last commit |
 * | feature branch with commits past the fork point | branch, last commit | branch |
 * | fresh feature branch (fork point = HEAD) | branch | branch |
 *
 * HEAD with no parent leaves the last commit unavailable, with `ROOT_COMMIT_REASON`.
 */
export class ImpactScopeResolver {
    constructor(
        private readonly git: ImpactGit = new ImpactGit(),
        private readonly diffScope: DiffScope = new DiffScope(),
    ) {}

    resolve(root: string): ImpactPlan | ImpactUnavailable {
        const head = this.git.sha(root, 'HEAD');
        if (head === null) return new ImpactUnavailable('git cannot resolve HEAD (not a git checkout, or git is unavailable)');
        const branch = this.git.branch(root);
        const dirty = this.git.dirty(root);
        const commit = this.lastCommit(root, dirty);
        // On main the decision is the branch NAME, never merge-base: unpushed commits still mean "last commit".
        if (branch === null || branch === MAIN_BRANCH) return new ImpactPlan([commit], ImpactKind.COMMIT);
        const fork = this.diffScope.detectBase(root);
        if (fork === null) {
            const reason = 'no fork point: neither origin/main nor main resolves';
            return new ImpactPlan(
                [new ImpactComparison(ImpactKind.BRANCH, null, 'Changed on this branch', dirty, reason)],
                ImpactKind.BRANCH,
            );
        }
        const onBranch = new ImpactComparison(
            ImpactKind.BRANCH,
            fork,
            `Changed on this branch (since ${this.short(fork)})${dirty ? UNCOMMITTED_SUFFIX : ''}`,
            dirty,
            '',
        );
        // A fresh branch has no commit of its own: "last commit" would be main's last PR, not its work.
        if (this.sameCommit(fork, head)) return new ImpactPlan([onBranch], ImpactKind.BRANCH);
        return new ImpactPlan([onBranch, commit], ImpactKind.BRANCH);
    }

    private lastCommit(root: string, dirty: boolean): ImpactComparison {
        const parent = this.git.sha(root, 'HEAD^');
        if (parent === null) return new ImpactComparison(ImpactKind.COMMIT, null, 'Last commit', dirty, ROOT_COMMIT_REASON);
        const subject = this.git.subject(root);
        const label =
            `Changed since ${this.short(parent)}${subject === '' ? '' : ` — ${subject}`}` +
            (dirty ? UNCOMMITTED_SUFFIX : '');
        return new ImpactComparison(ImpactKind.COMMIT, parent, label, dirty, '');
    }

    /** detectBase may hand back a full or an abbreviated sha; compare on the shorter of the two. */
    private sameCommit(a: string, b: string): boolean {
        const length = Math.min(a.length, b.length);
        return length > 0 && a.slice(0, length) === b.slice(0, length);
    }

    private short(sha: string): string {
        return sha.slice(0, 7);
    }
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

/**
 * nx's ownership map, computed at most ONCE however many comparisons ask for it. Failing is not
 * fatal: the set then shows in one shade, all "affected".
 */
export class SharedOwners {
    private pending: Promise<Map<string, string>> | null = null;

    constructor(private readonly ownership: ProjectFileOwners) {}

    get(): Promise<Map<string, string>> {
        if (this.pending === null) this.pending = this.load();
        return this.pending;
    }

    private async load(): Promise<Map<string, string>> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the second shade is optional
        try {
            return await this.ownership.owners();
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`⚠️  Impact: nx file ownership unavailable (${error.message}); showing one shade`);
            return new Map<string, string>();
        }
    }
}

/** The sets one scan found; an empty one is still an answer. */
class ImpactSets {
    constructor(
        public readonly touched: string[] = [],
        public readonly affected: string[] = [],
        public readonly buildInputs: string[] = [],
        public readonly dependencies: string[] = [],
        public readonly globalFiles: string[] = [],
    ) {}
}

export class NxImpactScanner {
    private readonly names = new GraphNames();

    constructor(
        private readonly diffScope: DiffScope = new DiffScope(),
        private readonly nx: NxCli = new NxCli(),
        private readonly ownership: ProjectFileOwners = new ProjectFileOwners(),
    ) {}

    /** Every comparison, in order, sharing one ownership map. */
    async scanAll(
        workspaceRoot: string,
        graph: EnhancedGraph,
        comparisons: ImpactComparison[],
    ): Promise<(ImpactReport | ImpactUnavailable)[]> {
        const owners = new SharedOwners(this.ownership);
        const results: (ImpactReport | ImpactUnavailable)[] = [];
        for (const comparison of comparisons) results.push(await this.scan(workspaceRoot, graph, comparison, owners));
        return results;
    }

    /** One comparison: nx affected from ITS base, with NO `--head`, so uncommitted work counts. */
    async scan(
        workspaceRoot: string,
        graph: EnhancedGraph,
        comparison: ImpactComparison,
        owners: SharedOwners = new SharedOwners(this.ownership),
    ): Promise<ImpactReport | ImpactUnavailable> {
        const base = comparison.base;
        if (base === null) return this.report(comparison, false, comparison.reason, '', 0, new ImpactSets());
        const json = this.nx.run(workspaceRoot, ['show', 'projects', '--affected', `--base=${base}`, '--json'], NX_TIMEOUT_MS);
        if (json === null)
            return new ImpactUnavailable(`nx show projects --affected failed or took over ${NX_TIMEOUT_MS / 1000}s`, comparison.label);
        const affectedSet = this.parse(json, graph);
        if (affectedSet === null)
            return new ImpactUnavailable('nx show projects --affected printed something other than a JSON list', comparison.label);
        const options = new ChangedFilesOptions();
        options.tsOnly = false;
        options.includeDeletions = true;
        const files = this.diffScope.getChangedFiles(workspaceRoot, base, undefined, options);
        const short = base.slice(0, 7);
        if (affectedSet.length === 0)
            return this.report(comparison, true, this.emptyNote(comparison, files.length, short), short, files.length, new ImpactSets());
        const map = await owners.get();
        const touched = this.touched(affectedSet, files, map);
        const rest = affectedSet.filter((project: string): boolean => !touched.includes(project));
        const sets = new ImpactSets(
            this.ids(touched),
            this.ids(rest),
            this.ids(this.buildInputs(affectedSet, graph)),
            this.ids(this.buildInputs(touched, graph)),
            this.globalFiles(files, map),
        );
        return this.report(comparison, true, '', short, files.length, sets);
    }

    /**
     * An empty scan is still an ANSWER (available, zero sets): a fresh branch with a clean tree has
     * simply changed nothing yet, and the page says so instead of disabling Impact.
     */
    emptyNote(comparison: ImpactComparison, changedFiles: number, short: string): string {
        if (changedFiles === 0 && comparison.kind === ImpactKind.BRANCH) return NOTHING_CHANGED_ON_BRANCH;
        if (changedFiles === 0) return `Nothing changed since ${short}`;
        return `Nothing affected since ${short}`;
    }

    /** Changed files no project owns; none are claimed when ownership itself was unavailable. */
    globalFiles(files: string[], owners: Map<string, string>): string[] {
        if (owners.size === 0) return [];
        return files.filter((file: string): boolean => !owners.has(file)).sort();
    }

    /**
     * Every transitive dependency of `roots` that is not itself one of them: a pure downward walk over
     * the graph's own dependsOn edges, no nx call. Of the affected set these are the build inputs; of
     * the touched set, "Changed + dependencies".
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

    private report(
        comparison: ImpactComparison,
        available: boolean,
        reason: string,
        base: string,
        changedFiles: number,
        sets: ImpactSets,
    ): ImpactReport {
        return new ImpactReport(
            comparison.kind,
            comparison.label,
            comparison.dirty,
            available,
            reason,
            base,
            sets.touched,
            sets.affected,
            sets.buildInputs,
            changedFiles,
            sets.dependencies,
            sets.globalFiles,
        );
    }

    private ids(projects: string[]): string[] {
        return projects.map((project: string): string => this.names.getNodeId(project));
    }
}

/** Writes (or removes) the sidecar, self-ignored, beside architecture/dependencies.html. */
export class ImpactSidecar {
    /** Never throws: a sidecar that cannot be written just leaves Impact disabled on the page. */
    write(architectureDir: string, data: ImpactSidecarData): string | null {
        const dir = path.join(architectureDir, IMPACT_SIDECAR_DIR);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- impact is optional; a write failure must never fail generation
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, '.gitignore'),
                '# Written by architecture:generate and architecture:visualize. Per-checkout data: never commit it.\n*\n',
                'utf-8',
            );
            const file = path.join(dir, IMPACT_SIDECAR_FILE);
            fs.writeFileSync(file, this.script(data), 'utf-8');
            return file;
        } catch (err: unknown) {
            const error = toError(err);
            console.warn(`⚠️  Could not write the impact sidecar: ${error.message}`);
            return null;
        }
    }

    /** A stale sidecar from an earlier checkout must never be shown as this one's impact. */
    remove(architectureDir: string): void {
        fs.rmSync(path.join(architectureDir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE), { force: true });
    }

    script(data: ImpactSidecarData): string {
        const json = JSON.stringify(data).replace(/</g, '\\u003c');
        return `// Generated by architecture:generate or architecture:visualize for one checkout. Gitignored; do not commit.\nwindow.__WP_IMPACT__ = ${json};\n`;
    }
}

/** The executors' one call: resolve, scan each comparison, write, and report one line per comparison. */
export class ImpactRefresh {
    constructor(
        private readonly scanner: NxImpactScanner = new NxImpactScanner(),
        private readonly sidecar: ImpactSidecar = new ImpactSidecar(),
        private readonly resolver: ImpactScopeResolver = new ImpactScopeResolver(),
    ) {}

    /**
     * Scans the comparisons in `kinds` that exist here (`VISUALIZE_IMPACT_KINDS` /
     * `GENERATE_IMPACT_KINDS`). Never throws — Impact is optional, generation is not.
     */
    async run(
        architectureDir: string,
        workspaceRoot: string,
        graph: EnhancedGraph,
        kinds: readonly ImpactKind[],
    ): Promise<string> {
        const started = Date.now();
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- impact is optional; any failure becomes a reason, never a failed generation
        try {
            const plan = this.resolver.resolve(workspaceRoot);
            if (plan instanceof ImpactUnavailable) return this.none(architectureDir, plan.reason, started);
            const comparisons = plan.comparisons.filter(
                (comparison: ImpactComparison): boolean => kinds.includes(comparison.kind),
            );
            if (comparisons.length === 0)
                return this.none(
                    architectureDir,
                    'no Changed-on-this-branch comparison on main or a detached HEAD; pnpm arch:visualize shows the last commit',
                    started,
                );
            const results = await this.scanner.scanAll(workspaceRoot, graph, comparisons);
            const lines = results.map((result: ImpactReport | ImpactUnavailable): string => this.line(result));
            const scans = results.filter(
                (result: ImpactReport | ImpactUnavailable): result is ImpactReport => result instanceof ImpactReport,
            );
            const cost = `${Date.now() - started} ms`;
            if (scans.length === 0) {
                this.sidecar.remove(architectureDir);
                return [...lines, `ℹ️  Impact disabled, no sidecar written (${cost})`].join('\n');
            }
            const file = this.sidecar.write(architectureDir, new ImpactSidecarData(scans, this.defaultKind(scans, plan.defaultKind)));
            return [...lines, file === null ? `⚠️  Impact sidecar not written (${cost})` : `→ ${file} (${cost})`].join('\n');
        } catch (err: unknown) {
            const error = toError(err);
            this.sidecar.remove(architectureDir);
            return `⚠️  Impact skipped: ${error.message}`;
        }
    }

    /** The plan's default when that scan is available, else the first available one. */
    private defaultKind(scans: ImpactReport[], preferred: ImpactKind): ImpactKind {
        const usable = scans.filter((scan: ImpactReport): boolean => scan.available);
        if (usable.length === 0 || usable.some((scan: ImpactReport): boolean => scan.kind === preferred)) return preferred;
        return usable[0].kind;
    }

    private none(architectureDir: string, reason: string, started: number): string {
        this.sidecar.remove(architectureDir);
        return `ℹ️  Impact disabled, no sidecar written: ${reason} (${Date.now() - started} ms)`;
    }

    private line(result: ImpactReport | ImpactUnavailable): string {
        if (result instanceof ImpactUnavailable || !result.available)
            return `ℹ️  Impact · ${result.label}: unavailable — ${result.reason}`;
        if (result.reason !== '') return `✅ Impact · ${result.label}: ${result.reason}`;
        return (
            `✅ Impact · ${result.label}: ${result.touched.length} changed · ${result.affected.length} dependents · ` +
            `${result.buildInputs.length} dependencies, from ${result.changedFiles} changed file(s)`
        );
    }
}
