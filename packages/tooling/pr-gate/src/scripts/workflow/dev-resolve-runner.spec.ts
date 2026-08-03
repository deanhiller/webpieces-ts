import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';
import { CliExitError, DotWebpieces, RepoRootFinder, toError } from '@webpieces/rules-config';

import { DevResolveRunner } from './dev-resolve-runner';
import { DevDeployRefs } from './dev-deploy-refs';
import { PushDevState, PushDevStateStore } from './push-dev-state';
import { GitExec, GitOutcome } from './git-exec';
import { GitStatusParser } from './git-status';

/**
 * The state machine: merge until something conflicts, hand the tree over, be resumed, publish.
 *
 * Every git command is recorded rather than run, and the point of several assertions is what is NOT in
 * that recording — nothing ever writes to the feature branch. That is the acceptance criterion the whole
 * feature exists to satisfy: if the feature branch acquired another developer's commits, landing its PR
 * would ship unreviewed work to production.
 */

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-resolve-spec-'));
const MINE = 'dev-include/dean/ONE-2275';
const FEATURE = 'dean/ONE-2275';
const TMP = 'dean/ONE-2275DevResolve';

class Harness {
    // Refs whose merge should FAIL, i.e. conflict.
    conflicting: Set<string> = new Set<string>();
    // Paths git reports as unmerged on `git diff --diff-filter=U`.
    unmerged: string[] = [];
    runs: string[][] = [];
    tries: string[][] = [];
    stateOnDisk: PushDevState | null = null;
    cleared = 0;
    out = '';
}

const harness = new Harness();

class FakeGitExec extends GitExec {
    constructor() {
        super(new RepoRootFinder(), new GitStatusParser());
    }

    override runGitChecked(args: string[]): void {
        harness.runs.push(args);
    }

    override assertNoUntracked(): void {
        // The real check needs a real tree; git-exec owns it.
    }

    override tryGit(args: string[]): GitOutcome {
        harness.tries.push(args);
        if (args.includes('merge') && !args.includes('--abort')) {
            const ref = args[args.length - 1].replace('refs/remotes/origin/', '');
            if (harness.conflicting.has(ref)) return new GitOutcome(1, '', 'CONFLICT');
        }
        return new GitOutcome(0, '', '');
    }

    override gitQuery(args: string[]): string {
        return args.includes('--diff-filter=U') ? harness.unmerged.join('\n') : '';
    }
}

class FakeRefs extends DevDeployRefs {
    constructor() {
        super(new FakeGitExec());
    }

    override fetchCopies(): void {
        // Which refs get fetched is DevDeployRefs' business; the sequencing under test is unaffected.
    }
}

class FakeStore extends PushDevStateStore {
    constructor() {
        super(new DotWebpieces());
    }

    override write(_repoRoot: string, state: PushDevState): void {
        // Snapshot, not alias: the runner mutates `state` in place as the queue drains.
        harness.stateOnDisk = new PushDevState(
            state.originalBranch, state.tmpBranch, state.targetRef, [...state.queue], state.current);
    }

    override clear(): void {
        harness.cleared += 1;
        harness.stateOnDisk = null;
    }
}

function runner(): DevResolveRunner {
    return new DevResolveRunner(new FakeGitExec(), new FakeRefs(), new FakeStore());
}

function state(queue: string[]): PushDevState {
    return new PushDevState(FEATURE, TMP, MINE, queue);
}

// Invoke `fn` with stdout captured; returns the CliExitError it threw, or null when it completed.
function capture(fn: () => void): CliExitError | null {
    const original = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one call
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string): boolean => {
        harness.out += chunk;
        return true;
    };
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        fn();
        return null;
    } catch (err: unknown) {
        const error = toError(err);
        // Every caller's assertion IS that a CliExitError reached here, so it is returned as a value to
        // be read rather than re-thrown. Anything else is a genuine failure and must propagate.
        if (error instanceof CliExitError) return error;
        throw error;
    } finally {
        (process.stdout as unknown as { write: typeof original }).write = original;
    }
}

// Did anything git-WRITE name the feature branch? A `checkout` back to it is the one legitimate mention.
const writesToFeatureBranch = (): boolean =>
    [...harness.runs, ...harness.tries].some(
        (args: string[]): boolean => args.includes(FEATURE) && !args.includes('checkout'));

beforeEach((): void => {
    harness.conflicting = new Set<string>();
    harness.unmerged = [];
    harness.runs = [];
    harness.tries = [];
    harness.stateOnDisk = null;
    harness.cleared = 0;
    harness.out = '';
});

describe('DevResolveRunner — the clean path needs no stage ②', () => {
    it('merges every queued ref, publishes the copy, and restores the original checkout', (): void => {
        const thrown = capture((): void => runner().start(REPO, state(['dev-include/amy/ONE-9']), 'base', []));
        expect(thrown).toBeNull();
        expect(harness.runs).toContainEqual(
            ['-C', REPO, 'push', '--force', 'origin', `${TMP}:refs/heads/${MINE}`]);
        expect(harness.runs).toContainEqual(['-C', REPO, 'checkout', FEATURE]);
        expect(harness.cleared).toBe(1);
        expect(harness.stateOnDisk).toBeNull();
    });

    it('parks on the throwaway branch, and never writes to the feature branch', (): void => {
        capture((): void => runner().start(REPO, state([]), `refs/remotes/origin/${MINE}`, []));
        expect(harness.runs).toContainEqual(
            ['-C', REPO, 'checkout', '-B', TMP, `refs/remotes/origin/${MINE}`]);
        expect(writesToFeatureBranch()).toBe(false);
    });
});

describe('DevResolveRunner — the conflict path', () => {
    beforeEach((): void => {
        harness.conflicting = new Set<string>(['dev-include/amy/ONE-9']);
        harness.unmerged = ['src/a.ts', 'src/b.ts'];
    });

    it('stops, lists the conflicted files, and leaves the state file behind', (): void => {
        const thrown = capture((): void => runner().start(REPO, state(['dev-include/amy/ONE-9']), 'base', []));
        expect(thrown?.exitCode).toBe(2);
        expect(thrown?.message).toContain('src/a.ts');
        expect(thrown?.message).toContain('src/b.ts');
        expect(thrown?.message).toContain('pnpm wp-finish-push-dev');
        expect(harness.stateOnDisk?.current).toBe('dev-include/amy/ONE-9');
        expect(harness.cleared).toBe(0);
        expect(writesToFeatureBranch()).toBe(false);
    });

    it('refuses to finish while anything is still unmerged, and re-prints the list', (): void => {
        const halted = state([]);
        halted.current = 'dev-include/amy/ONE-9';
        const thrown = capture((): void => runner().resume(REPO, halted));
        expect(thrown?.exitCode).toBe(2);
        expect(thrown?.message).toContain('Conflicts are NOT resolved yet');
        expect(thrown?.message).toContain('src/a.ts');
        expect(harness.runs.some((args: string[]): boolean => args.includes('commit'))).toBe(false);
    });

    it('commits, resumes the queue, and publishes once the files are resolved', (): void => {
        harness.unmerged = [];
        const halted = state(['dev-include/zoe/ONE-1']);
        halted.current = 'dev-include/amy/ONE-9';
        const thrown = capture((): void => runner().resume(REPO, halted));
        expect(thrown).toBeNull();
        expect(harness.runs).toContainEqual(['-C', REPO, 'add', '-u']);
        expect(harness.runs).toContainEqual(['-C', REPO, 'commit', '--no-edit']);
        expect(harness.runs.some((args: string[]): boolean => args.includes('push'))).toBe(true);
        expect(harness.cleared).toBe(1);
    });

    it('can stop AGAIN on a later ref — the queue is resumed, not replayed', (): void => {
        harness.unmerged = [];
        harness.conflicting = new Set<string>(['dev-include/zoe/ONE-1']);
        const halted = state(['dev-include/zoe/ONE-1']);
        halted.current = 'dev-include/amy/ONE-9';
        const thrown = capture((): void => runner().resume(REPO, halted));
        expect(thrown?.message).toContain('CONFLICT merging dev-include/zoe/ONE-1');
        expect(harness.stateOnDisk?.current).toBe('dev-include/zoe/ONE-1');
        // The ref that was already resolved is NOT merged a second time.
        const merges = harness.tries.filter((args: string[]): boolean => args.includes('merge'));
        expect(merges.some((args: string[]): boolean => args.join(' ').includes('amy/ONE-9'))).toBe(false);
    });
});

describe('DevResolveRunner — --abort', () => {
    it('restores the original branch and leaves no tmp branch and no state file', (): void => {
        const halted = state(['dev-include/zoe/ONE-1']);
        halted.current = 'dev-include/amy/ONE-9';
        capture((): void => runner().abort(REPO, halted));
        expect(harness.tries).toContainEqual(['-C', REPO, 'merge', '--abort']);
        expect(harness.runs).toContainEqual(['-C', REPO, 'checkout', FEATURE]);
        expect(harness.tries).toContainEqual(['-C', REPO, 'branch', '-D', TMP]);
        expect(harness.cleared).toBe(1);
        expect(harness.runs.some((args: string[]): boolean => args.includes('push'))).toBe(false);
    });
});
