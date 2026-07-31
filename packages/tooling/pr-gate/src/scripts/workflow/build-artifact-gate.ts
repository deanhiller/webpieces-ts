import { CliExitError, matchesAnyGlob } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { BuildAffected } from './build-affected';
import { GeneratedArtifactRegistry, GeneratedArtifacts } from './generated-artifact-registry';
import { GitExec } from './git-exec';
import { GitStatusEntry } from './git-status';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * What the repo-wide post-build tree check concluded, split into the ticket's two verdicts. Both lists
 * can be non-empty at once, and when they are BOTH are reported — a stray artifact does not hide a
 * stale design file or vice versa.
 */
export class BuildArtifactVerdict {
    /** Verdict 1 — dirty, but the build is SUPPOSED to write it: you did not commit the regeneration. */
    staleGenerated: GitStatusEntry[];
    /** Verdict 2 — dirty and nobody declared it: the build is emitting uncommitted git artifacts. */
    strayArtifacts: GitStatusEntry[];

    constructor(staleGenerated: GitStatusEntry[], strayArtifacts: GitStatusEntry[]) {
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
        // statusEntries, never a raw/trimmed string: the staged-vs-unstaged answer arrives as a boolean
        // so no caller can re-derive it from column positions and get it backwards.
        const verdict = this.classify(this.gitExec.statusEntries(repoRoot), artifacts);
        if (verdict.isClean()) {
            process.stdout.write('\n✅ Build left the tree committed — no uncommitted build artifacts.\n');
            return;
        }
        throw new CliExitError(1, this.render(repoRoot, verdict, artifacts));
    }

    /**
     * Sort every UNSATISFIED status entry into the two verdicts. Pure, so the specs drive it with
     * literal porcelain text (run through `GitStatusParser`) instead of building repos.
     *
     * THE PREDICATE lives in {@link GitStatusEntry.isCommittedOrStaged} — a clean worktree column
     * means the change is committed or staged, and `??` is excluded because its second column is not
     * a worktree state at all.
     */
    classify(entries: readonly GitStatusEntry[], artifacts: GeneratedArtifacts): BuildArtifactVerdict {
        const stale: GitStatusEntry[] = [];
        const stray: GitStatusEntry[] = [];
        for (const entry of entries) {
            if (entry.isCommittedOrStaged()) continue;
            if (matchesAnyGlob(entry.path, artifacts.paths)) stale.push(entry);
            else stray.push(entry);
        }
        return new BuildArtifactVerdict(stale, stray);
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

    private listing(entries: readonly GitStatusEntry[]): string {
        return entries
            .map((e: GitStatusEntry): string => `   ${e.indexStatus}${e.worktreeStatus}  ${e.path}${e.isUntracked() ? '   (untracked — brand new)' : ''}\n`)
            .join('');
    }
}
