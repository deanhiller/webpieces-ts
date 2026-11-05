import * as fs from 'fs';

import { DotWebpieces } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';

/** The local state file stage ② writes and stage ③ consumes. LOCAL scope: one worktree's verification. */
export const PUSH_DEV_VERIFIED_FILE = 'push-dev-verified.json';

/**
 * What `wp-build-push-dev` (stage ②) verified, for `wp-finish-push-dev` (stage ③) to publish (#1403).
 *
 * The same hand-off the PR flow makes between `wp-review-upsert-pr` and `wp-finish-upsert-pr`: stage ②
 * records the sha it built, and stage ③ refuses when HEAD moved since — so what is published is exactly
 * what was checked against dev and built, never a later commit nobody built.
 *
 * Data-only (per CLAUDE.md) — the behaviour lives in {@link VerifiedDevCopyStore}.
 */
export class VerifiedDevCopy {
    /** The feature branch that was verified. */
    branch: string;
    /** The feature head the copy is built on. Stage ③ refuses when HEAD is no longer this. */
    headSha: string;
    /** What stage ③ publishes: `headSha`, or `headSha` plus ONE commit recording the resolved files. */
    copySha: string;
    /** `<namespace>/<branch>` — where stage ③ publishes. */
    targetRef: string;
    /** The remote copy's sha when stage ② ran ('' = not published yet) — stage ③'s push lease. */
    leaseSha: string;
    /** The `origin/<devBranch>` sha the copy was merged with and built against; '' when dev did not exist. */
    devSha: string;

    constructor(branch: string, headSha: string, copySha: string, targetRef: string, leaseSha: string, devSha: string) {
        this.branch = branch;
        this.headSha = headSha;
        this.copySha = copySha;
        this.targetRef = targetRef;
        this.leaseSha = leaseSha;
        this.devSha = devSha;
    }
}

/**
 * Reads, writes and clears the stage-② record. A missing or unreadable record reads as null, which stage ③
 * turns into "run `pnpm wp-build-push-dev` first".
 */
@injectable(bindingScopeValues.Singleton)
export class VerifiedDevCopyStore {
    constructor(private readonly dotWebpieces: DotWebpieces) {}

    path(repoRoot: string): string {
        return this.dotWebpieces.localFile(repoRoot, PUSH_DEV_VERIFIED_FILE);
    }

    /**
     * The local ref that keeps the verified copy reachable between stage ② and stage ③. When something
     * conflicted, the copy is a commit on top of the feature head that no branch points at; without a ref
     * holding it, `git gc` could collect it before it is published. Outside `refs/heads/`, so it is never
     * mistaken for a branch (and never counts toward the branch cap or reaches `wp-cleanup`).
     */
    keepRef(branch: string): string {
        return `refs/webpieces/push-dev/${branch}`;
    }

    read(repoRoot: string): VerifiedDevCopy | null {
        const file = this.path(repoRoot);
        if (!fs.existsSync(file)) return null;
        // webpieces-disable no-any-unknown -- JSON.parse is untyped until narrowed on the next line
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VerifiedDevCopy>;
        const fields = [raw.branch, raw.headSha, raw.copySha, raw.targetRef, raw.leaseSha, raw.devSha];
        if (!fields.every((f: string | undefined): boolean => typeof f === 'string')) return null;
        return new VerifiedDevCopy(
            raw.branch as string, raw.headSha as string, raw.copySha as string,
            raw.targetRef as string, raw.leaseSha as string, raw.devSha as string,
        );
    }

    write(repoRoot: string, record: VerifiedDevCopy): void {
        fs.mkdirSync(this.dotWebpieces.local(repoRoot), { recursive: true });
        fs.writeFileSync(this.path(repoRoot), JSON.stringify(record, null, 2) + '\n', 'utf8');
    }

    clear(repoRoot: string): void {
        const file = this.path(repoRoot);
        if (fs.existsSync(file)) fs.rmSync(file);
    }
}
