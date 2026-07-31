import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * Where the "known generated" answer came from, so a failure message can say whether it is speaking
 * from the workspace's own declarations or from the built-in fallback.
 */
export const ARTIFACT_SOURCE_NX = 'nx project graph (target `outputs`)';
export const ARTIFACT_SOURCE_FALLBACK = 'built-in fallback (nx project graph unavailable)';

/**
 * The fallback "known generated" set, used ONLY when the nx project graph cannot be read (nx not
 * installed, `nx graph` failed, unparseable output). It deliberately mirrors what the webpieces nx
 * plugin declares as `outputs` today — `di-graph-generate` writes design.{json,md,html} per project
 * and the architecture targets write architecture/*.
 *
 * It is a fallback and not the primary source precisely because a hand-maintained list drifts: the
 * moment a repo adds a target that writes a new committed artifact, only the nx `outputs` declaration
 * knows about it. Data (a module-level table), not a list buried inside a function.
 */
export const FALLBACK_GENERATED_PATHS: readonly string[] = [
    '**/design.json',
    '**/design.md',
    '**/design.html',
    'architecture/dependencies.json',
    'architecture/dependencies.html',
    'architecture/runtime-dependencies.json',
];

/**
 * The set of repo-relative paths/globs that a build is EXPECTED to rewrite, plus where the set came
 * from. Data-only (per CLAUDE.md) — the resolution logic lives in GeneratedArtifactRegistry.
 */
export class GeneratedArtifacts {
    paths: string[];
    source: string;

    constructor(paths: string[], source: string) {
        this.paths = paths;
        this.source = source;
    }
}

/**
 * Answers "is this path something the build is SUPPOSED to rewrite?" from the workspace's own nx
 * target `outputs` declarations rather than from a parallel list maintained by hand.
 *
 * Why nx `outputs`: every target that writes a checked-in artifact already has to declare it there or
 * nx caching corrupts the workspace, so the declaration is load-bearing and therefore maintained. A
 * second list in the PR gate would be maintained by nobody and would drift the first time a repo adds
 * a generator. One `nx graph --file=<tmp>` dumps the whole workspace (every project, every target,
 * every `outputs` entry) in one ~2s call, so this costs one subprocess per PR-gate run.
 *
 * Tokens: `{projectRoot}` and `{workspaceRoot}` are expanded; anything still holding a `{...}` token
 * (`{options.outputPath}`, `{options.outputFile}`) is DROPPED — it is only resolvable per-invocation,
 * and such targets write into `dist/`, which is gitignored and therefore invisible to this gate anyway.
 */
@injectable(bindingScopeValues.Singleton)
export class GeneratedArtifactRegistry {
    // Resolved once per process: the graph does not change while one PR-gate command runs.
    private cached: GeneratedArtifacts | null = null;

    /** The declared build outputs for this repo, from nx when readable and the fallback table otherwise. */
    resolve(repoRoot: string): GeneratedArtifacts {
        if (this.cached !== null) return this.cached;
        const fromNx = this.readNxOutputs(repoRoot);
        this.cached = fromNx !== null
            ? new GeneratedArtifacts(fromNx, ARTIFACT_SOURCE_NX)
            : new GeneratedArtifacts(FALLBACK_GENERATED_PATHS.slice(), ARTIFACT_SOURCE_FALLBACK);
        return this.cached;
    }

    /** Test seam: pre-seed the resolved set so specs never shell out to nx. */
    seed(artifacts: GeneratedArtifacts): void {
        this.cached = artifacts;
    }

    /**
     * Dump the nx project graph to a temp file and collect every target's `outputs`. Returns null (not
     * an empty list) when nx is unavailable or unreadable, so the caller can tell "no nx" apart from
     * "nx says this workspace declares nothing".
     */
    private readNxOutputs(repoRoot: string): string[] | null {
        const nxBin = path.join(repoRoot, 'node_modules', '.bin', 'nx');
        if (!fs.existsSync(nxBin)) return null;
        const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nxgraph-')), 'graph.json');
        const run = spawnSync(nxBin, ['graph', '--file', outFile], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
        if (run.status !== 0 || !fs.existsSync(outFile)) return null;
        return this.parseGraph(outFile);
    }

    /** Read + narrow the dumped graph. Null on anything unreadable, so the caller falls back. */
    private parseGraph(outFile: string): string[] | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable/corrupt graph dump must
        // fall back to the built-in table, never fail a PR flow over a cache artifact we only consult
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- opaque nx JSON, narrowed field by field below
            const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as NxGraphFile;
            const nodes = parsed.graph?.nodes;
            if (nodes === undefined) return null;
            return this.collectOutputs(nodes);
        } catch (err: unknown) {
            const error = toError(err);
            void error; // unreadable graph => fall back to the built-in table
            return null;
        }
    }

    /** Walk every project → every target → every `outputs` entry, expanding the nx path tokens. */
    private collectOutputs(nodes: Record<string, NxGraphNode>): string[] {
        const found = new Set<string>();
        for (const projectName of Object.keys(nodes)) {
            const data = nodes[projectName].data;
            const targets = data.targets;
            if (targets === undefined) continue;
            for (const targetName of Object.keys(targets)) {
                for (const raw of targets[targetName].outputs ?? []) {
                    const expanded = this.expand(raw, data.root ?? '.');
                    if (expanded !== null) found.add(expanded);
                }
            }
        }
        return Array.from(found).sort();
    }

    /** Expand `{projectRoot}` / `{workspaceRoot}`; drop anything still carrying an unresolved token. */
    private expand(raw: string, projectRoot: string): string | null {
        const replaced = raw
            .replace(/\{projectRoot\}/g, projectRoot)
            .replace(/\{workspaceRoot\}\//g, '')
            .replace(/\{workspaceRoot\}/g, '.');
        if (replaced.includes('{')) return null;
        const normalized = replaced.replace(/\\/g, '/').replace(/^\.\//, '');
        return normalized === '' || normalized === '.' ? null : normalized;
    }
}

// Structural views of the `nx graph --file=<json>` payload. Interfaces (not classes) on purpose: these
// describe a foreign JSON shape we narrow, never something this codebase constructs.
interface NxGraphFile {
    graph?: NxGraphBody;
}

interface NxGraphBody {
    nodes?: Record<string, NxGraphNode>;
}

interface NxGraphNode {
    data: NxProjectData;
}

interface NxProjectData {
    root?: string;
    targets?: Record<string, NxTarget>;
}

interface NxTarget {
    outputs?: string[];
}
