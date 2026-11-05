import { NativeProcessApi } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from './git-exec';

const MAIN_REF = 'refs/remotes/origin/main';

/**
 * How much of one dev copy is already on `origin/main`. Data-only per CLAUDE.md.
 *
 * `changed` is every file the copy changes relative to its merge-base with `origin/main`; `landed` is the
 * subset whose content on `origin/main` is now identical to the copy's.
 */
export class DevCopyLanding {
    constructor(
        readonly changed: string[],
        readonly landed: string[],
    ) {}

    /** Every file the copy changes already has the copy's content on main — removing it takes nothing off dev. */
    fullyOnMain(): boolean {
        return this.landed.length === this.changed.length;
    }

    /** Some, but not all, of the copy's files are already on main. */
    partlyOnMain(): boolean {
        return this.landed.length > 0 && !this.fullyOnMain();
    }
}

/** The merged PR a copy's branch landed through, for the refusal message. Data-only. */
export class MergedPr {
    constructor(
        readonly num: string,
        readonly mergedAt: string,
    ) {}
}

// `<number> <mergedAt>` as the --jq below prints it; an empty list prints `null null`, which does not match.
const PR_LINE = /^(\d+) (\S+)$/;

/**
 * Answers "is this dev copy already on `origin/main`?" for `wp-finish-push-dev --remove` (#1401), and for
 * `wp-build-push-dev`'s automatic resolution of conflicts caused only by landed copies (#1405).
 *
 * WHY: developers ran `--remove` after their PR landed, as a "done, clean up" habit. On a repo that composes
 * `dev` = `origin/main` + every copy, that remove takes nothing off dev (main keeps the change there) and
 * still triggers a full recompose that can redeploy every service. Only rolling back a copy that broke dev is
 * a real reason to remove.
 *
 * HOW: a pure content check, no GitHub dependency. The files the copy changes since its merge-base with
 * `origin/main` (`git diff A...B`), minus the files where `origin/main` and the copy still differ
 * (`git diff A B`), are the files already landed. Both refs must already be fetched. `--no-renames` so a
 * rename counts both its old and new path rather than hiding the deletion.
 */
@injectable(bindingScopeValues.Singleton)
export class DevCopyOnMain {
    constructor(
        private readonly gitExec: GitExec,
        private readonly processes: NativeProcessApi,
    ) {}

    async landing(repoRoot: string, copyRef: string): Promise<DevCopyLanding> {
        const copy = `refs/remotes/origin/${copyRef}`;
        const changed = await this.names(repoRoot, [`${MAIN_REF}...${copy}`],
            `Failed to list the files ${copyRef} changes since its merge-base with origin/main (git diff ${MAIN_REF}...${copy}).`);
        const stillDiffer = new Set(await this.names(repoRoot, [MAIN_REF, copy],
            `Failed to compare ${copyRef} with origin/main (git diff ${MAIN_REF} ${copy}).`));
        const landed = changed.filter((f: string): boolean => !stillDiffer.has(f));
        return new DevCopyLanding(changed, landed);
    }

    /**
     * The merged PR whose head was `branch`, or null. A `gh` that is missing, unauthenticated or offline
     * yields null rather than an error, and null is always the SAFE answer: for `--remove` it only drops a
     * decoration from the refusal (the content check above has already decided), and for the landed-copy
     * resolution (#1405) it means "not proven landed", so the conflict is left for the developer.
     */
    async mergedPr(repoRoot: string, branch: string): Promise<MergedPr | null> {
        const result = await this.processes.run('gh', [
            'pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1',
            '--json', 'number,mergedAt', '--jq', '.[0] | "\\(.number) \\(.mergedAt)"',
        ], repoRoot);
        if (!result.ok) return null;
        const match = PR_LINE.exec(result.stdout.trim());
        if (match === null) return null;
        return new MergedPr(match[1], match[2]);
    }

    private async names(repoRoot: string, revs: string[], failMsg: string): Promise<string[]> {
        const out = await this.gitExec.gitQuery(['-C', repoRoot, 'diff', '--name-only', '--no-renames', ...revs], repoRoot, failMsg);
        return out.split('\n').map((l: string): string => l.trim()).filter((l: string): boolean => l !== '');
    }
}
