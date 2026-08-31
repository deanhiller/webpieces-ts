import { AuthorizationContext, ChangedFilesOptions, DiffScope } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { DiffBasisResolver } from './diff-basis';

/**
 * THE changed-file set the review system judges a branch by — extracted so the checklist scanner and the
 * authorization commands cannot answer it two different ways.
 *
 * Two non-default options, both load-bearing, and both the reason this is worth a class rather than a
 * repeated three-liner:
 *
 * `tsOnly:false`          — the default drops every *.sql / Dockerfile / .env* file, silently shrinking the
 *                           set a reviewer is pointed at — and, here, the set an approval's scope is
 *                           checked against, which would let terraform-adjacent files slip inside a
 *                           "terraform only" grant.
 * `includeDeletions:true` — the default is `--diff-filter=d`, so a DELETED file is invisible. A PR that
 *                           deletes a migration or an auth check changed exactly what a checklist exists
 *                           to catch.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewChangedFiles {
    constructor(private readonly diffScope: DiffScope) {}

    /**
     * Every file changed since `base`, INCLUDING uncommitted and untracked ones. [] when there is no base.
     *
     * No head argument — that is the branch of `getChangedFiles` which diffs base → WORKING TREE and unions
     * in untracked files. Passing a head would diff commit-to-commit and miss staged, unstaged and
     * untracked work, so an approval could be verified against a scope the working tree has already grown
     * out of.
     */
    since(repoRoot: string, base: string): string[] {
        if (base === '') return [];
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        opts.includeDeletions = true;
        return this.diffScope.getChangedFiles(repoRoot, base, undefined, opts);
    }
}

/**
 * Gathers the ONE branch state a human authorization is minted against and verified against: the stable
 * feature name, the fork point, and the changed-file set.
 *
 * Why the FEATURE name and not `git branch --show-current`: the 3-point merge parks the checkout on a
 * transient `<feature>Squash` branch, and an approval keyed to the raw branch name would stop verifying
 * for exactly as long as the flow that needs it is running. `AiBranchName.getFeatureName()` is already the
 * stable identity every other per-branch artifact is keyed by, so an approval lives and dies with the same
 * unit of work as the review it authorizes.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class AuthorizationContextResolver {
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly diffBasisResolver: DiffBasisResolver,
        private readonly changedFiles: ReviewChangedFiles,
    ) {}

    resolve(repoRoot: string): AuthorizationContext {
        const base = this.diffBasisResolver.resolve(repoRoot).base;
        return new AuthorizationContext(
            this.aiBranchName.getFeatureName(), base, this.changedFiles.since(repoRoot, base));
    }

    /**
     * The scope globs PROPOSED for a fresh approval, derived from what the diff touches today: one
     * `<dir>/**` per distinct directory, collapsed to the first two path segments so a deep tree yields a
     * readable handful rather than one glob per folder.
     *
     * Proposed, never imposed — `wp-authorize` prints these and lets the human replace them. The derived
     * default matters anyway, because the alternative to a good default is a human who types `**` to get
     * past the prompt, and `**` is the widening-by-absence this whole mechanism exists to make impossible
     * to reach by accident.
     */
    proposeScopePaths(changedFiles: readonly string[]): string[] {
        const globs = new Set<string>();
        for (const file of changedFiles) {
            const parts = file.split('/');
            if (parts.length === 1) globs.add(file);
            else globs.add(`${parts.slice(0, Math.min(2, parts.length - 1)).join('/')}/**`);
        }
        return [...globs].sort();
    }
}
