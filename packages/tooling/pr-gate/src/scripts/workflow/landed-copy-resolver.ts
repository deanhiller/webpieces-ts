import { DevDeployConfig } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from './git-exec';
import { DevCopy, DevDeployRefs } from './dev-deploy-refs';
import { DevCopyLanding, DevCopyOnMain } from './dev-copy-on-main';

/**
 * One conflicted file resolved automatically, and the landed copies whose old version of it was
 * overridden. Data-only per CLAUDE.md.
 */
export class LandedOverride {
    constructor(
        readonly file: string,
        /** The copy refs (`dev-include/<branch>`) whose dev-side version of `file` was overridden. */
        readonly copies: string[],
    ) {}
}

/** What {@link LandedCopyResolver.resolve} did: what it took the publisher's side on, and what is left. Data-only. */
export class LandedResolution {
    constructor(
        readonly overridden: LandedOverride[],
        /** The conflicted files nothing could prove safe to resolve automatically — the developer's job. */
        readonly remaining: string[],
    ) {}
}

/** One live copy and how it relates to `origin/main`, computed once per resolve. Data-only. */
class CopyOnMain {
    constructor(
        readonly copy: DevCopy,
        readonly landing: DevCopyLanding,
        /** The copy's branch has a MERGED PR — it landed, possibly with different content (review, squash). */
        readonly branchLanded: boolean,
    ) {}

    /** Is the copy's version of `file` superseded by main — its branch landed, or main already carries it? */
    supersededOn(file: string): boolean {
        return this.branchLanded || this.landing.landed.includes(file);
    }
}

/**
 * Resolves the conflicts of `wp-build-push-dev`'s dev merge that are caused ONLY by copies already on main
 * (#1405), by taking the publisher's side.
 *
 * THE SHAPE IT CURES: a copy is published to dev, then its branch lands on main with DIFFERENT content
 * (review commits, then a squash). `dev` still holds the published version of those lines, every branch cut
 * from the latest main carries the landed version, and so every new publish conflicts in the same files —
 * the landed copy's old version against its own final version, with nobody's own change involved.
 *
 * WHY THE PUBLISHER'S SIDE IS RIGHT: the publisher's branch contains the latest `origin/main` (stage ②
 * refuses one that does not), so it already carries the landed copy's FINAL version of the file. Taking it
 * loses nothing, and the copy's content is unchanged, so nothing is redeployed. Dropping landed copies when
 * dev is composed would also cure it, but that is a recompose — a full redeploy (#1401).
 *
 * WHEN IT ACTS, per conflicted file: every live copy that changes the file (relative to its merge-base with
 * `origin/main`) is superseded by main — its branch has a merged PR, or main already holds the copy's content
 * of that file. One copy that is NOT on main, or no copy at all explaining the dev side, and the file is left
 * for the developer, exactly as before: that conflict is somebody's live work.
 */
@injectable(bindingScopeValues.Singleton)
export class LandedCopyResolver {
    constructor(
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly onMain: DevCopyOnMain,
    ) {}

    /** Resolve what it can (taking HEAD's side, then `git add`), and return what it did and what remains. */
    async resolve(repoRoot: string, cfg: DevDeployConfig, conflicted: string[]): Promise<LandedResolution> {
        const copies = await this.refs.liveCopies(repoRoot, cfg);
        await this.refs.fetchCopies(repoRoot, copies.map((c: DevCopy): string => c.ref));
        const touching = await this.copiesTouching(repoRoot, copies, conflicted);
        const overridden: LandedOverride[] = [];
        const remaining: string[] = [];
        for (const file of conflicted) {
            const contributors = touching.filter((c: CopyOnMain): boolean => c.landing.changed.includes(file));
            const allLanded = contributors.length > 0
                && contributors.every((c: CopyOnMain): boolean => c.supersededOn(file));
            if (!allLanded) {
                remaining.push(file);
                continue;
            }
            await this.takePublishersSide(repoRoot, file);
            overridden.push(new LandedOverride(file, contributors.map((c: CopyOnMain): string => c.copy.ref)));
        }
        return new LandedResolution(overridden, remaining);
    }

    /** The report line block for what was overridden; '' when nothing was. */
    describe(resolution: LandedResolution): string {
        if (resolution.overridden.length === 0) return '';
        return '\nResolved automatically — the dev side came only from copies already on origin/main, so your\n'
            + "branch (which carries main's final version) was taken:\n"
            + resolution.overridden.map((o: LandedOverride): string => `  ${o.file}   ← overrode ${o.copies.join(', ')}`).join('\n')
            + '\n';
    }

    // Only the copies that change at least one conflicted file matter; the merged-PR lookup is paid for those only.
    private async copiesTouching(repoRoot: string, copies: DevCopy[], conflicted: string[]): Promise<CopyOnMain[]> {
        const touching: CopyOnMain[] = [];
        for (const copy of copies) {
            const landing = await this.onMain.landing(repoRoot, copy.ref);
            if (!landing.changed.some((f: string): boolean => conflicted.includes(f))) continue;
            const pr = await this.onMain.mergedPr(repoRoot, copy.sourceBranch);
            touching.push(new CopyOnMain(copy, landing, pr !== null));
        }
        return touching;
    }

    // HEAD is the throwaway, i.e. the publisher's branch. A file HEAD deleted stays deleted.
    private async takePublishersSide(repoRoot: string, file: string): Promise<void> {
        const inHead = await this.gitExec.tryGit(['-C', repoRoot, 'cat-file', '-e', `HEAD:${file}`], repoRoot);
        const args = inHead.ok
            ? ['-C', repoRoot, 'checkout', '--ours', '--', file]
            : ['-C', repoRoot, 'rm', '-q', '--ignore-unmatch', '--', file];
        await this.gitExec.runGitChecked(args, `Failed to take your branch's side of ${file}`);
        if (inHead.ok) {
            await this.gitExec.runGitChecked(['-C', repoRoot, 'add', '--', file], `Failed to stage the resolution of ${file}`);
        }
    }
}
