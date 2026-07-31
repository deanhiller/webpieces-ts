import * as path from 'path';
import {
    DeletableWorktree,
    InformAiError,
    RepoRootFinder,
    WorktreeReapResult,
    loadAndValidate,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { WorktreeCleanupSection } from './worktree-cleanup';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The CHILD side of `wp-land-pr`'s re-exec: reap ONE named worktree, from a process whose cwd is the
 * primary clone.
 *
 * It is not a published `bin`. Nothing about it is a verb a human should reach for — `pnpm wp-cleanup`
 * is that verb, and it does strictly more. This exists so the parent can hand off a SINGLE, already
 * identified corpse without also reaping every other agent's worktree as a side effect of landing one
 * PR. LandedWorktreeReaper spawns it by absolute path; see that class for why a child rather than a
 * `process.chdir`.
 *
 * WHAT IT WILL NOT TAKE ON TRUST. The parent tells it a path and a branch; it believes neither.
 * The verdict is recomputed here, from scratch, by the same MergedBranchesService that backs
 * `wp-cleanup` — so a worktree is removed only when it is PROVABLY dead (its PR is merged), and never
 * because a caller said so. That is what keeps "never remove a tree still holding unmerged work" true
 * even if the parent is wrong, out of date, or someone runs this by hand.
 *
 * The primary clone can never be a target: `classifyWorktrees` drops the main worktree from the
 * verdicts outright, so a path pointing at it simply does not resolve to a target — and WorktreeReaper
 * refuses it a second time by name. Neither rail is load-bearing alone.
 */
@injectable(bindingScopeValues.Singleton)
export class ReapWorktreeCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly worktreeSection: WorktreeCleanupSection,
    ) {}

    async run(args: string[]): Promise<void> {
        await Promise.resolve();
        const request = this.parse(args);
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());

        const target = this.resolveTarget(repoRoot, request);
        if (target === null) return;

        const retention = loadAndValidate(repoRoot).prGate.landPr.branchRetention;
        const result = this.worktreeSection.reap(repoRoot, 'wp-land-pr', [target], retention);
        process.stdout.write(this.render(result));
    }

    /**
     * The verdict for the requested path, or null after printing WHY it is not reapable. Refusals are
     * printed rather than thrown: the PR they follow is already merged, and exiting non-zero after a
     * successful landing would report a landed PR as a failed command.
     */
    private resolveTarget(repoRoot: string, request: ReapRequest): DeletableWorktree | null {
        const wanted = path.resolve(request.worktreePath);
        const target = this.worktreeSection.verdicts(repoRoot)
            .find((tree: DeletableWorktree): boolean => path.resolve(tree.path) === wanted);

        if (target === undefined) {
            process.stdout.write(
                `\n   ℹ️  ${request.worktreePath} is not a removable worktree of this repo (it may be the\n`
                + '       primary clone, or already gone). Nothing removed.\n');
            return null;
        }
        // The branch moved under us between landing and reaping — somebody checked something else out
        // there. Whatever that is, it is not the corpse we were asked to bury.
        if (target.branch !== request.branch) {
            process.stdout.write(
                `\n   ⚠️  ${request.worktreePath} now holds '${target.branch}', not '${request.branch}'.\n`
                + '       Refusing to remove a worktree whose branch changed since the PR landed.\n');
            return null;
        }
        if (!target.deletable) {
            process.stdout.write(
                `\n   ⚠️  ${request.worktreePath} is not provably dead: ${target.reason}\n`
                + '       Refusing to remove a worktree that may still hold unmerged work.\n');
            return null;
        }
        return target;
    }

    // The reap report, plus the spared case — which report() renders as '' because from wp-cleanup's
    // point of view "nothing happened" is a whole answer. Here it never is: we asked for exactly one.
    private render(result: WorktreeReapResult): string {
        if (result.reaped.length === 0 && result.failed.length === 0) {
            let out = '\n' + SEP + '🛑 Nothing removed\n' + SEP + '\n';
            for (const tree of result.spared) out += `   · ${tree.path} — ${tree.reason}\n`;
            return out;
        }
        return this.worktreeSection.report(result);
    }

    // `<worktree-path> <branch>`, both required. Thrown rather than printed: bad argv means the caller
    // is broken, and there is no landed PR in this process whose success a non-zero exit could misreport.
    private parse(args: string[]): ReapRequest {
        const worktreePath = args[0] ?? '';
        const branch = args[1] ?? '';
        if (worktreePath === '' || branch === '') {
            throw new InformAiError(
                '\n' + SEP + '❌ wp-reap-worktree: missing arguments\n' + SEP + '\n'
                + 'Usage: node wp-reap-worktree.js <worktree-path> <branch>\n\n'
                + 'This is an INTERNAL entry point, spawned by `pnpm wp-land-pr` with cwd set to the\n'
                + 'primary clone. To clean up by hand, run `pnpm wp-cleanup` from the primary clone.\n' + SEP);
        }
        return new ReapRequest(worktreePath, branch);
    }
}

// Data-only (per CLAUDE.md, classes for data): the pair of argv values this entry point takes.
class ReapRequest {
    worktreePath: string;
    branch: string;

    constructor(worktreePath: string, branch: string) {
        this.worktreePath = worktreePath;
        this.branch = branch;
    }
}
