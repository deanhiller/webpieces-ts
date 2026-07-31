import { CliExitError, matchesAnyGlob } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { BuildAffected } from './build-affected';
import { GeneratedArtifactRegistry, GeneratedArtifacts } from './generated-artifact-registry';
import { GitExec } from './git-exec';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * One path `git status --porcelain` reported as NOT satisfying "committed OR staged", with the two
 * porcelain status columns kept so a message can say why. Data-only (per CLAUDE.md).
 */
export class DirtyPath {
    path: string;
    indexStatus: string;     // porcelain column 1 — the INDEX (staged) state
    worktreeStatus: string;  // porcelain column 2 — the WORKING TREE state

    constructor(dirtyPath: string, indexStatus: string, worktreeStatus: string) {
        this.path = dirtyPath;
        this.indexStatus = indexStatus;
        this.worktreeStatus = worktreeStatus;
    }

    /** `?? path` — untracked, i.e. the build created a brand-new file nobody has ever committed. */
    isUntracked(): boolean {
        return this.indexStatus === '?';
    }
}

/**
 * What the repo-wide post-build tree check concluded, split into the ticket's two verdicts. Both lists
 * can be non-empty at once, and when they are BOTH are reported — a stray artifact does not hide a
 * stale design file or vice versa.
 */
export class BuildArtifactVerdict {
    /** Verdict 1 — dirty, but the build is SUPPOSED to write it: you did not commit the regeneration. */
    staleGenerated: DirtyPath[];
    /** Verdict 2 — dirty and nobody declared it: the build is emitting uncommitted git artifacts. */
    strayArtifacts: DirtyPath[];

    constructor(staleGenerated: DirtyPath[], strayArtifacts: DirtyPath[]) {
        this.staleGenerated = staleGenerated;
        this.strayArtifacts = strayArtifacts;
    }

    isClean(): boolean {
        return this.staleGenerated.length === 0 && this.strayArtifacts.length === 0;
    }
}

/**
 * The repo-wide "did the build leave anything uncommitted?" gate, run in `wp-review-upsert-pr` right
 * after `buildCommand`.
 *
 * It REPLACES the per-project `validate-di-graph-unchanged` nx target, which asked the same question in
 * the wrong place. That target used `git status --porcelain` as its oracle while itself dirtying the
 * tree, so nx (which hashes by file CONTENTS) saw one hash produce both a pass and a fail and labelled
 * the task "flaky" — it was not flaky, it was stateful in a dimension nx cannot see. It also could not
 * pass mid-merge, where `merge-in-progress-guard` blocks the `git commit` it demanded.
 *
 * THE PREDICATE IS "committed OR staged", and that is the whole trick:
 *
 *   porcelain column 1 = index state, column 2 = working-tree state.
 *   Satisfied  ⇔  column 2 is ' ' AND the entry is not `??`.
 *
 * A normal branch commits its regenerated design files → clean → passes. Mid-merge `git commit` is
 * blocked but `git add` is expected (and the gate itself commits the resolution) → staged → passes.
 * ONE rule covering both, with no merge special-case and no skip, because a special case is a second
 * rule and two rules for one invariant is how they drift.
 *
 * Coverage is strictly larger than the target it replaces: that one only ever looked at `design.*` in
 * one project, this looks at the WHOLE repo, so a build that quietly writes anywhere else is caught for
 * the first time.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildArtifactGate {
    constructor(
        private readonly gitExec: GitExec,
        private readonly registry: GeneratedArtifactRegistry,
        private readonly buildAffected: BuildAffected,
    ) {}

    /**
     * Run the check and throw CliExitError when the build left the tree dirty. Called immediately after
     * the build gate passes, while the tree still holds exactly what the build produced.
     */
    assertBuildLeftNothingUncommitted(repoRoot: string): void {
        const artifacts = this.registry.resolve(repoRoot);
        // porcelainStatus, NOT uncommittedFiles: the latter trims, which eats the leading space that IS
        // the index column, turning every unstaged " M path" into a staged-looking "M path".
        const verdict = this.classify(this.gitExec.porcelainStatus(repoRoot), artifacts);
        if (verdict.isClean()) {
            process.stdout.write('\n✅ Build left the tree committed — no uncommitted build artifacts.\n');
            return;
        }
        throw new CliExitError(1, this.render(repoRoot, verdict, artifacts));
    }

    /**
     * Parse `git status --porcelain` and sort every UNSATISFIED entry into the two verdicts. Pure, so
     * the specs drive it with literal porcelain text instead of building repos for every case.
     */
    classify(porcelain: string, artifacts: GeneratedArtifacts): BuildArtifactVerdict {
        const stale: DirtyPath[] = [];
        const stray: DirtyPath[] = [];
        for (const line of porcelain.split('\n')) {
            const entry = this.parseLine(line);
            if (entry === null) continue;
            if (matchesAnyGlob(entry.path, artifacts.paths)) stale.push(entry);
            else stray.push(entry);
        }
        return new BuildArtifactVerdict(stale, stray);
    }

    /**
     * One porcelain line → a DirtyPath, or null when the line is blank or already satisfied.
     *
     * Format is `XY <path>`, with `XY` = index+worktree status and `R  old -> new` for renames (the NEW
     * path is the one on disk, so that is the one classified). Untracked is `?? <path>`.
     */
    private parseLine(line: string): DirtyPath | null {
        if (line.length < 4) return null;
        const indexStatus = line.charAt(0);
        const worktreeStatus = line.charAt(1);
        // THE PREDICATE. A clean worktree column means the change is committed or staged — satisfied.
        // `??` is the one entry whose column 2 is not a worktree state, so it is excluded explicitly.
        if (worktreeStatus === ' ' && indexStatus !== '?') return null;
        const raw = line.slice(3).trim();
        const arrow = raw.indexOf(' -> ');
        const filePath = arrow >= 0 ? raw.slice(arrow + 4) : raw;
        const unquoted = filePath.startsWith('"') && filePath.endsWith('"') ? filePath.slice(1, -1) : filePath;
        return unquoted === '' ? null : new DirtyPath(unquoted, indexStatus, worktreeStatus);
    }

    /** The full failure message — verdict 1 section, verdict 2 section, or both. */
    private render(repoRoot: string, verdict: BuildArtifactVerdict, artifacts: GeneratedArtifacts): string {
        const buildCommand = this.buildAffected.resolveBuildCommand(repoRoot);
        const parts: string[] = ['\n' + SEP + '❌ The build left uncommitted changes in the working tree\n' + SEP];
        if (verdict.staleGenerated.length > 0) parts.push(this.renderStale(verdict, buildCommand));
        if (verdict.strayArtifacts.length > 0) parts.push(this.renderStray(verdict));
        parts.push(
            `\nThe rule is one line: after the build, every changed path must be COMMITTED **or** STAGED.\n` +
            `Staged counts, which is why this also works mid-3-point-merge, where \`git commit\` is blocked\n` +
            `by merge-in-progress-guard but \`git add\` is exactly what you are supposed to do.\n\n` +
            `Known-generated paths came from: ${artifacts.source}\n` + SEP);
        return parts.join('');
    }

    private renderStale(verdict: BuildArtifactVerdict, buildCommand: string): string {
        return `\nYou did not run \`${buildCommand}\` and commit the regenerated design files, so the\n` +
            `review cannot proceed. These are declared build outputs and the build just rewrote them:\n\n` +
            this.listing(verdict.staleGenerated) +
            `\nFix it by running the build and committing (or staging) the result:\n\n` +
            `    ${buildCommand}\n` +
            `    git add -A && git commit -m "regenerate design files"\n`;
    }

    private renderStray(verdict: BuildArtifactVerdict): string {
        return `\nYour build is generating uncommitted git artifacts, so I cannot continue the PR process.\n` +
            `Either (1, best) write them to an output directory that is in \`.gitignore\`, or (2) add a new\n` +
            `dir to \`.gitignore\`.\n\n` +
            `These paths are NOT declared as the output of any build target:\n\n` +
            this.listing(verdict.strayArtifacts);
    }

    private listing(entries: readonly DirtyPath[]): string {
        return entries
            .map((e: DirtyPath): string => `   ${e.indexStatus}${e.worktreeStatus}  ${e.path}${e.isUntracked() ? '   (untracked — brand new)' : ''}\n`)
            .join('');
    }
}
