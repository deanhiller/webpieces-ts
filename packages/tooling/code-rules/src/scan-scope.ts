/**
 * Which FILES a diff-scoped code rule judges, for every mode it offers — and the one place the per-run
 * `--projects` restriction of the debug run (#1027) is applied.
 *
 *   NEW_AND_MODIFIED_CODE  — the changed files (the rule then keeps only sites on changed lines)
 *   NEW_AND_MODIFIED_FILES — the changed files, whole
 *   MODIFIED_PROJECTS      — every in-scope file of every project the diff touches, whole, plus the
 *                            changed files themselves (so it is never narrower than NEW_AND_MODIFIED_FILES)
 *   RUN_EVERY_TIME         — every in-scope file in the repo, whole, every run
 *
 * The two whole-scope modes are NEW_AND_MODIFIED_FILES over a bigger file set — the rule's own detection,
 * disable handling and failure text are untouched, which is what lets a debug run print exactly what the
 * gate would print. A rule asks {@link ScanScope.files} instead of `getChangedFiles`, and asks
 * {@link ScanScope.isLineScoped} instead of comparing its mode to NEW_AND_MODIFIED_CODE.
 *
 * Every rule that reads its files here also reports its sites through {@link ScanScope.recordSites}, so
 * the debug run can print a count per project without parsing any rule's output.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ChangedFilesOptions, DiffScope, InformAiError, ModifiedCodeMode, toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/** One nx project: its name and its directory (repo-relative, '/'-separated, no trailing slash). */
export class ProjectEntry {
    constructor(
        readonly name: string,
        readonly dir: string,
    ) {}
}

/** The only field of a project.json this catalog reads. */
type RawProjectName = { name?: string };

/**
 * The repo's nx projects, found from the `project.json` files git knows about (tracked or untracked,
 * never ignored), and the owner lookup every whole-scope mode and `--projects` filter uses: a file
 * belongs to the DEEPEST project directory containing it.
 */
@injectable(bindingScopeValues.Singleton)
export class ProjectCatalog {
    private cachedRoot: string | undefined;
    private cached: ProjectEntry[] = [];

    constructor(private readonly diffScope: DiffScope) {}

    all(workspaceRoot: string): ProjectEntry[] {
        if (this.cachedRoot !== workspaceRoot) {
            this.cached = this.load(workspaceRoot);
            this.cachedRoot = workspaceRoot;
        }
        return this.cached;
    }

    /** The project owning `relFile`, or undefined when no project directory contains it. */
    ownerOf(workspaceRoot: string, relFile: string): ProjectEntry | undefined {
        const file = relFile.split(path.sep).join('/');
        let best: ProjectEntry | undefined;
        for (const project of this.all(workspaceRoot)) {
            const inside = project.dir === '' || file.startsWith(`${project.dir}/`);
            if (inside && (best === undefined || project.dir.length > best.dir.length)) best = project;
        }
        return best;
    }

    private load(workspaceRoot: string): ProjectEntry[] {
        const jsons = this.diffScope.getAllFiles(workspaceRoot, { tsOnly: false })
            .filter((f: string) => f === 'project.json' || f.endsWith('/project.json'));
        return jsons.map((rel: string) => {
            const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
            return new ProjectEntry(this.readName(path.join(workspaceRoot, rel)) ?? path.posix.basename(dir), dir);
        });
    }

    private readName(fullPath: string): string | undefined {
        // webpieces-disable no-unmanaged-exceptions -- add the exact project.json path while preserving the parse/read failure as cause
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RawProjectName;
            return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`Cannot read nx project identity from ${fullPath} — fix project.json and retry.`, {
                cause: error,
            });
        }
    }
}

/**
 * The per-run project restriction. Bound at the composition root: `undefined` for every normal run (the
 * gate), the `--projects` names for a debug run. Data-only.
 */
export class ScanRestriction {
    constructor(readonly projectNames: readonly string[] | undefined) {}
}

/** One recorded violating site: which rule, which file. Data-only. */
export class RecordedSite {
    constructor(
        readonly ruleName: string,
        readonly relFile: string,
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class ScanScope {
    private readonly sites: RecordedSite[] = [];

    constructor(
        private readonly diffScope: DiffScope,
        private readonly catalog: ProjectCatalog,
        private readonly restriction: ScanRestriction,
    ) {}

    /** True when the rule keeps only sites on changed lines; every other active mode judges whole files. */
    isLineScoped(mode: ModifiedCodeMode): boolean {
        return mode === 'NEW_AND_MODIFIED_CODE';
    }

    /**
     * The files a rule in `mode` judges, restricted to the debug run's `--projects` when there is one.
     * `opts` is passed through to the git listing (`tsOnly: false` for a rule that reads templates/CSS).
     */
    files(workspaceRoot: string, mode: ModifiedCodeMode, base: string, head: string | undefined, opts?: ChangedFilesOptions): string[] {
        return this.restrict(workspaceRoot, this.unrestricted(workspaceRoot, mode, base, head, opts));
    }

    /** Record every violating site a rule found, for the debug run's per-project count. */
    recordSites(ruleName: string, relFiles: readonly string[]): void {
        for (const relFile of relFiles) this.sites.push(new RecordedSite(ruleName, relFile));
    }

    /** Sites recorded so far, counted per owning project name (`(no project)` for a file outside one). */
    countsByProject(workspaceRoot: string): Map<string, number> {
        const counts = new Map<string, number>();
        for (const site of this.sites) {
            const name = this.catalog.ownerOf(workspaceRoot, site.relFile)?.name ?? '(no project)';
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return counts;
    }

    private unrestricted(workspaceRoot: string, mode: ModifiedCodeMode, base: string, head: string | undefined, opts?: ChangedFilesOptions): string[] {
        if (mode === 'RUN_EVERY_TIME') return this.diffScope.getAllFiles(workspaceRoot, opts);
        const changed = this.diffScope.getChangedFiles(workspaceRoot, base, head, opts);
        if (mode !== 'MODIFIED_PROJECTS') return changed;
        // A project is TOUCHED by any changed file it owns — not only the files this rule reads — so a
        // project.json or README edit counts, exactly as nx affected would see it.
        const touched = new Set<string>();
        for (const f of this.diffScope.getChangedFiles(workspaceRoot, base, head, { tsOnly: false })) {
            const owner = this.catalog.ownerOf(workspaceRoot, f);
            if (owner !== undefined) touched.add(owner.dir);
        }
        const inTouched = this.diffScope.getAllFiles(workspaceRoot, opts).filter((f: string) => {
            const owner = this.catalog.ownerOf(workspaceRoot, f);
            return owner !== undefined && touched.has(owner.dir);
        });
        return Array.from(new Set([...changed, ...inTouched]));
    }

    private restrict(workspaceRoot: string, files: string[]): string[] {
        const names = this.restriction.projectNames;
        if (names === undefined) return files;
        const wanted = new Set(names);
        return files.filter((f: string) => {
            const owner = this.catalog.ownerOf(workspaceRoot, f);
            return owner !== undefined && wanted.has(owner.name);
        });
    }
}

/**
 * The gate's {@link ScanScope} — the diff, no project restriction — for a caller that builds a validator
 * outside the DI container: the single-rule nx executors (`validate-no-any-unknown` and friends) and specs.
 */
export class GateScanScope extends ScanScope {
    constructor() {
        const diffScope = new DiffScope();
        super(diffScope, new ProjectCatalog(diffScope), new ScanRestriction(undefined));
    }
}
