import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from './git-exec';

/**
 * "Does this branch already contain the latest `origin/main`?" — the question both ends of the dev-deploy
 * flow ask (#1403). `wp-start-push-dev` asks it to decide whether to run the 3-point merge at all (it runs
 * ONLY when the branch is behind), and `wp-build-push-dev` asks it to refuse a copy built from a stale
 * fork point: such a copy builds against a `node_modules` missing whatever main added since, while dev
 * already contains it.
 *
 * Always FETCHES first. A local `origin/main` from last week answers "contains main" confidently and
 * wrongly, which is the exact staleness this check exists to catch.
 */
@injectable(bindingScopeValues.Singleton)
export class MainFreshness {
    constructor(private readonly gitExec: GitExec) {}

    async containsLatestMain(repoRoot: string): Promise<boolean> {
        await this.gitExec.runGitChecked(['-C', repoRoot, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
            'Failed to fetch origin/main to check whether this branch is up to date with it');
        const contains = await this.gitExec.tryGit(
            ['-C', repoRoot, 'merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'HEAD'], repoRoot);
        return contains.ok;
    }
}
