/**
 * The FILE SET a diff-scoped rule judges — the one central place the whole-scope modes of #1027
 * (`MODIFIED_PROJECTS`, `RUN_EVERY_TIME`) and the debug run's `--projects` filter are implemented.
 *
 * Every diff-scoped validator asks `DiffScope.getChangedFiles` which files to look at and
 * `DiffScope.getFileDiff` which lines changed. Both consult the {@link FileScope} the caller is
 * running inside (`diffScope.within(scope, work)`), so the widening happens ONCE, here, and no rule
 * carries its own copy of it:
 *
 *   DIFF              — today's behaviour: the files the diff changed.
 *   MODIFIED_PROJECTS — those files PLUS every file of every project any changed file belongs to.
 *   RUN_EVERY_TIME    — every file in the repo (tracked + untracked, honouring .gitignore).
 *
 * Under both whole-scope kinds every file is judged WHOLE: `getFileDiff` reports every line as added,
 * so a rule's line- or method-scoped logic sees the entire file as new. A widening can therefore never
 * report LESS than the diff-scoped mode it replaces.
 *
 * `projectRoots`, when set, keeps only files whose owning project (nearest `project.json`) is one of
 * those roots. It is what `--projects` on the debug run compiles to; the gate never sets it.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { InformAiError } from './inform-ai-error';
import { WholeScopeMode, WHOLE_SCOPE_MODES } from './rule-configs';
import { toError } from './to-error';

/** The one field of a project.json / package.json this module reads. */
type RawNamedJson = { name?: string };

export type FileScopeKind = 'DIFF' | WholeScopeMode;

/**
 * The per-file judging mode a whole-scope run substitutes, most-whole first. Since a whole-scope run
 * also reports every line as changed, any of these judges the entire file; the preference only picks
 * the rule's most natural spelling of "the whole file".
 */
const WHOLE_FILE_JUDGE_PREFERENCE = [
    'NEW_AND_MODIFIED_FILES',
    'MODIFIED_CLASS',
    'NEW_AND_MODIFIED_METHODS',
    'NEW_AND_MODIFIED_CODE',
    'NEW_METHODS',
] as const;

/** Which files a rule run judges. Data-only; see the file comment. */
export class FileScope {
    static readonly DIFF = new FileScope('DIFF', null);

    constructor(
        readonly kind: FileScopeKind,
        /** Repo-relative project roots to keep ('.' = a project at the repo root), or null = all. */
        readonly projectRoots: readonly string[] | null,
    ) {}

    /** True when this is exactly today's diff scope — no widening, no project filter. */
    isPlainDiff(): boolean {
        return this.kind === 'DIFF' && this.projectRoots === null;
    }

    /** True for MODIFIED_PROJECTS / RUN_EVERY_TIME: every selected file is judged whole. */
    isWhole(): boolean {
        return this.kind !== 'DIFF';
    }
}

/** The two questions every consumer of the whole-scope modes asks about a mode string. */
export class WholeScopeModes {
    /** True when `mode` is one of the two whole-scope modes. */
    isWholeScopeMode(mode: string | undefined): mode is WholeScopeMode {
        return (WHOLE_SCOPE_MODES as readonly string[]).includes(mode ?? '');
    }

    /**
     * The per-file mode a rule runs with while its FILE SET is widened, or null when the rule's mode
     * set has no diff-scoped mode at all (a PROJECT_MODES / STRUCTURAL_MODES rule, whose own
     * `MODIFIED_PROJECTS` / `RUN_EVERY_TIME` it implements itself and which must not be rewritten).
     */
    wholeFileJudgeMode(modeSet: readonly string[]): string | null {
        return WHOLE_FILE_JUDGE_PREFERENCE.find((m: string) => modeSet.includes(m)) ?? null;
    }
}

/**
 * Maps files to the nx project that owns them (the nearest ancestor holding a `project.json`) and
 * project NAMES to their roots. Parser-free and cached per instance: one run builds one index.
 */
export class ProjectIndex {
    private readonly rootByDir = new Map<string, string | null>();
    private namesToRoots: Map<string, string> | null = null;

    constructor(private readonly workspaceRoot: string) {}

    /** Repo-relative root of the project owning `relFile` ('.' for a repo-root project), or null. */
    rootOf(relFile: string): string | null {
        return this.rootOfDir(path.posix.dirname(relFile.split(path.sep).join('/')));
    }

    /** The roots of the named projects. Throws naming every unknown name and the known ones. */
    rootsFor(names: readonly string[]): string[] {
        const index = this.names();
        const unknown = names.filter((n: string) => !index.has(n));
        if (unknown.length > 0) {
            const known = Array.from(index.keys()).sort();
            throw new InformAiError(
                `--projects names ${unknown.map((n: string) => `'${n}'`).join(', ')}, which no project.json in ` +
                    `${this.workspaceRoot} declares. Known projects: ${known.join(', ')}`,
            );
        }
        return names.map((n: string) => index.get(n) as string);
    }

    /** The project name declared for `root`, for reports (the root itself when no project.json names it). */
    nameOf(root: string): string {
        for (const entry of this.names()) {
            if (entry[1] === root) return entry[0];
        }
        return root;
    }

    private rootOfDir(dir: string): string | null {
        const cached = this.rootByDir.get(dir);
        if (cached !== undefined) return cached;
        let found: string | null;
        if (fs.existsSync(path.join(this.workspaceRoot, dir, 'project.json'))) {
            found = dir === '' ? '.' : dir;
        } else if (dir === '.' || dir === '' || dir === '/') {
            found = null;
        } else {
            found = this.rootOfDir(path.posix.dirname(dir));
        }
        this.rootByDir.set(dir, found);
        return found;
    }

    private names(): Map<string, string> {
        if (this.namesToRoots !== null) return this.namesToRoots;
        const map = new Map<string, string>();
        for (const projectJson of new RepoFileLister().list(this.workspaceRoot, ['project.json', '*/project.json'])) {
            const root = path.posix.dirname(projectJson);
            map.set(this.readName(root), root === '' ? '.' : root);
        }
        this.namesToRoots = map;
        return map;
    }

    // nx's own precedence: project.json `name`, else the sibling package.json `name`, else the dir.
    private readName(root: string): string {
        for (const file of ['project.json', 'package.json']) {
            const name = this.readJsonName(path.join(this.workspaceRoot, root, file));
            if (name !== null) return name;
        }
        return path.posix.basename(root);
    }

    private readJsonName(fullPath: string): string | null {
        if (!fs.existsSync(fullPath)) return null;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RawNamedJson;
            return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // swallow — a malformed project.json falls back to the directory name
            return null;
        }
    }
}

/** Lists repo files — tracked plus untracked-not-ignored — that still exist on disk. */
export class RepoFileLister {
    list(workspaceRoot: string, pathspecs: readonly string[]): string[] {
        const spec = pathspecs.length === 0 ? '' : ` -- ${pathspecs.map((p: string) => `'${p}'`).join(' ')}`;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const output = execSync(`git ls-files --cached --others --exclude-standard${spec}`, {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 256 * 1024 * 1024,
            });
            const files = output.split('\n').filter((f: string) => f.length > 0);
            return Array.from(new Set(files)).filter((f: string) => fs.existsSync(path.join(workspaceRoot, f)));
        } catch (err: unknown) {
            const error = toError(err);
            // NOT swallowed: an empty list here would make a whole-scope run judge zero files and PASS,
            // and a debug run report "TOTAL 0" — a false "nothing left" that is worse than a failure.
            throw new InformAiError(
                `A whole-scope rule run (MODIFIED_PROJECTS / RUN_EVERY_TIME) could not list the repo's files: ` +
                    `\`git ls-files\` failed in ${workspaceRoot}: ${error.message}`,
                { cause: error },
            );
        }
    }
}

/**
 * Turns the diff's changed files into the files a {@link FileScope} selects. `keep` is the caller's
 * own filter (ts-only, no tests) so a widened set obeys exactly the same in-scope test as the diff.
 */
export class ScopedFileSelector {
    select(
        workspaceRoot: string,
        scope: FileScope,
        diffFiles: readonly string[],
        touchedFiles: () => readonly string[],
        pathspecs: readonly string[],
        keep: (file: string) => boolean,
    ): string[] {
        const projects = new ProjectIndex(workspaceRoot);
        const selected = this.widen(workspaceRoot, scope, diffFiles, touchedFiles, pathspecs, keep, projects);
        if (scope.projectRoots === null) return selected;
        const allowed = new Set(scope.projectRoots);
        return selected.filter((f: string) => allowed.has(projects.rootOf(f) ?? ''));
    }

    private widen(
        workspaceRoot: string,
        scope: FileScope,
        diffFiles: readonly string[],
        touchedFiles: () => readonly string[],
        pathspecs: readonly string[],
        keep: (file: string) => boolean,
        projects: ProjectIndex,
    ): string[] {
        if (scope.kind === 'DIFF') return [...diffFiles];
        const repoFiles = new RepoFileLister().list(workspaceRoot, pathspecs).filter(keep);
        if (scope.kind === 'RUN_EVERY_TIME') return repoFiles;
        const touched = new Set<string>();
        for (const file of touchedFiles()) {
            const root = projects.rootOf(file);
            if (root !== null) touched.add(root);
        }
        const inTouched = repoFiles.filter((f: string) => touched.has(projects.rootOf(f) ?? ''));
        return Array.from(new Set([...diffFiles, ...inTouched]));
    }
}
