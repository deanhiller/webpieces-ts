import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';
import { CliExitError, DevDeployConfig, DotWebpieces, RepoRootFinder } from '@webpieces/rules-config';

import { PushDevCommand, PushDevOptions } from './push-dev-command';
import { DevCopy, DevDeployRefs } from '../workflow/dev-deploy-refs';
import { PushDevState, PushDevStateStore } from '../workflow/push-dev-state';
import { DevResolveRunner } from '../workflow/dev-resolve-runner';
import { DevDeployWatchHints } from '../workflow/dev-deploy-watch-hints';
import { GitExec, GitOutcome } from '../workflow/git-exec';
import { GitStatusParser } from '../workflow/git-status';

/**
 * The behaviour under test is the DECISIONS wp-push-dev makes — which branches it refuses, when it
 * refuses to clobber a published resolution, and what it hands the resolve runner. The git calls are
 * recorded rather than executed; dev-resolve-runner.spec.ts covers the merge/publish sequencing, and a
 * real remote round-trip is not something a unit test should be inventing.
 */

// A real (empty) directory, because every wp-* command opens by refreshing the AI-facing workflow doc
// into `<repoRoot>/.webpieces/instruct-ai/` — a fictional path would fail before any decision is made.
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-push-dev-spec-'));
const MY_COPY = 'dev-include/dean/ONE-2275';

class Harness {
    branch = 'dean/ONE-2275';
    copies: DevCopy[] = [];
    remoteShas: Map<string, string> = new Map<string, string>();
    aheadCount = 0;
    resolveInProgress: PushDevState | null = null;
    cleanTreeCalls = 0;
    gitRuns: string[][] = [];
    startedBase = '';
    startedState: PushDevState | null = null;
    out = '';
}

const harness = new Harness();

class FakeGitExec extends GitExec {
    constructor() {
        super(new RepoRootFinder(), new GitStatusParser());
    }

    override assertCleanTree(): void {
        harness.cleanTreeCalls += 1;
    }

    override runGitChecked(args: string[]): void {
        harness.gitRuns.push(args);
    }

    override tryGit(): GitOutcome {
        return new GitOutcome(0, '', '');
    }
}

class FakeRefs extends DevDeployRefs {
    constructor() {
        super(new FakeGitExec());
    }

    override config(): DevDeployConfig {
        return new DevDeployConfig('dev-include', 'dev');
    }

    override currentBranch(): string {
        return harness.branch;
    }

    override liveCopies(): DevCopy[] {
        return harness.copies;
    }

    override remoteSha(_repoRoot: string, ref: string): string {
        return harness.remoteShas.get(ref) ?? '';
    }

    override fetchCopies(): void {
        // Recorded nowhere on purpose: which refs got fetched is dev-resolve-runner.spec.ts's business.
    }

    override commitsOnlyOnRemote(): number {
        return harness.aheadCount;
    }

    override headSha(): string {
        return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    }
}

class FakeStore extends PushDevStateStore {
    constructor() {
        super(new DotWebpieces());
    }

    override read(): PushDevState | null {
        return harness.resolveInProgress;
    }
}

class FakeRunner extends DevResolveRunner {
    constructor() {
        super(new FakeGitExec(), new FakeRefs(), new FakeStore());
    }

    override start(_repoRoot: string, state: PushDevState, base: string): void {
        harness.startedState = state;
        harness.startedBase = base;
    }

    override announce(): string {
        return '';
    }
}

class FakeRootFinder extends RepoRootFinder {
    override resolveRepoRoot(): string {
        return REPO;
    }
}

function command(): PushDevCommand {
    return new PushDevCommand(
        new FakeRootFinder(), new FakeGitExec(), new FakeRefs(), new FakeStore(), new FakeRunner(),
        new DevDeployWatchHints());
}

function options(): PushDevOptions {
    return new PushDevOptions();
}

// Run the command with stdout captured, so a test can assert on what the human actually reads.
async function run(opts: PushDevOptions): Promise<void> {
    const original = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one run
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string): boolean => {
        harness.out += chunk;
        return true;
    };
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await command().run(opts);
    } finally {
        (process.stdout as unknown as { write: typeof original }).write = original;
    }
}

/**
 * The message of the CliExitError the command is EXPECTED to throw. Written as `.then(onOk, onErr)`
 * rather than try/catch because the assertion is that it throws AND that the text steers correctly, and
 * vitest's `rejects` matcher cannot hand the message back for the substring checks.
 */
async function refusalMessage(opts: PushDevOptions): Promise<string> {
    const thrown: unknown = await run(opts).then((): unknown => null, (err: unknown): unknown => err);
    expect(thrown).toBeInstanceOf(CliExitError);
    return (thrown as CliExitError).message;
}

const pushArgs = (): string[] | undefined =>
    harness.gitRuns.find((args: string[]): boolean => args.includes('push'));

beforeEach((): void => {
    harness.branch = 'dean/ONE-2275';
    harness.copies = [];
    harness.remoteShas = new Map<string, string>();
    harness.aheadCount = 0;
    harness.resolveInProgress = null;
    harness.cleanTreeCalls = 0;
    harness.gitRuns = [];
    harness.startedBase = '';
    harness.startedState = null;
    harness.out = '';
});

describe('PushDevCommand — publishing', () => {
    it('pushes HEAD to <namespace>/<branch>, never to the branch itself', async (): Promise<void> => {
        await run(options());
        expect(pushArgs()).toEqual(['-C', REPO, 'push', 'origin', `HEAD:refs/heads/${MY_COPY}`]);
        expect(harness.cleanTreeCalls).toBe(1);
    });

    it('tells the AI how to watch it reach the dev server, fully substituted', async (): Promise<void> => {
        await run(options());
        // Both questions, in the order that keeps the answer honest: ancestry first (provably about YOUR
        // code), run status second (about the machinery).
        expect(harness.out).toContain('git merge-base --is-ancestor deadbeefdeadbeefdeadbeefdeadbeefdeadbeef origin/dev');
        expect(harness.out).toContain(`gh run list --branch ${MY_COPY} --limit 5`);
    });

    it('force-with-leases against the sha it inspected when the copy already exists', async (): Promise<void> => {
        harness.remoteShas.set(MY_COPY, 'abc123');
        await run(options());
        expect(pushArgs()).toContain(`--force-with-lease=refs/heads/${MY_COPY}:abc123`);
    });
});

describe('PushDevCommand — the clobber guard', () => {
    beforeEach((): void => {
        harness.remoteShas.set(MY_COPY, 'abc123');
        harness.aheadCount = 2;
    });

    it('refuses rather than force-pushing over a published resolution, and names both ways out', async (): Promise<void> => {
        const message = await refusalMessage(options());
        expect(message).toContain('2 commit(s) your branch does not');
        expect(message).toContain('pnpm wp-push-dev --rebase-resolution');
        expect(message).toContain('pnpm wp-push-dev --force');
        expect(pushArgs()).toBeUndefined();
    });

    it('--force overwrites', async (): Promise<void> => {
        const opts = options();
        opts.force = true;
        await run(opts);
        expect(pushArgs()).toContain('--force');
    });

    it('--rebase-resolution replays the resolution onto the LOCAL head instead of discarding it', async (): Promise<void> => {
        const opts = options();
        opts.rebaseResolution = true;
        await run(opts);
        expect(harness.startedBase).toBe('HEAD');
        expect(harness.startedState?.queue).toEqual([MY_COPY]);
        // The whole point: the feature branch is the return address, never a merge target.
        expect(harness.startedState?.originalBranch).toBe('dean/ONE-2275');
        expect(pushArgs()).toBeUndefined();
    });
});

describe('PushDevCommand — refusals', () => {
    it('refuses main — the trunk already deploys', async (): Promise<void> => {
        harness.branch = 'main';
        expect(await refusalMessage(options())).toContain('Refusing to publish a dev copy of `main`');
    });

    it('refuses the composed dev branch, which CI owns', async (): Promise<void> => {
        harness.branch = 'dev';
        expect(await refusalMessage(options())).toContain('BUILD ARTIFACT');
    });

    it('refuses a detached HEAD, which has no name to derive the copy from', async (): Promise<void> => {
        harness.branch = 'HEAD';
        expect(await refusalMessage(options())).toContain('Detached HEAD');
    });

    it('refuses a copy of a copy rather than nesting the namespace', async (): Promise<void> => {
        harness.branch = MY_COPY;
        expect(await refusalMessage(options())).toContain('dev copy of a dev copy');
    });

    it('refuses while a resolve is half-finished, naming the two ways out', async (): Promise<void> => {
        harness.resolveInProgress = new PushDevState('dean/ONE-2275', 'tmp', MY_COPY, []);
        const message = await refusalMessage(options());
        expect(message).toContain('pnpm wp-finish-push-dev');
        expect(message).toContain('--abort');
    });
});

describe('PushDevCommand — --remove and --list', () => {
    it('--remove deletes exactly the copy ref', async (): Promise<void> => {
        harness.remoteShas.set(MY_COPY, 'abc123');
        const opts = options();
        opts.remove = true;
        await run(opts);
        expect(harness.gitRuns).toEqual([['-C', REPO, 'push', 'origin', '--delete', `refs/heads/${MY_COPY}`]]);
    });

    it('--remove on an unpublished branch says so instead of failing', async (): Promise<void> => {
        const opts = options();
        opts.remove = true;
        await run(opts);
        expect(harness.gitRuns).toEqual([]);
        expect(harness.out).toContain('Nothing to remove');
    });

    it('--list shows exactly the live copies', async (): Promise<void> => {
        harness.copies = [
            new DevCopy('dev-include/amy/ONE-9', 'aaaaaaaa11', 'amy/ONE-9'),
            new DevCopy(MY_COPY, 'bbbbbbbb22', 'dean/ONE-2275'),
        ];
        const opts = options();
        opts.list = true;
        await run(opts);
        expect(harness.out).toContain('dev-include/amy/ONE-9');
        expect(harness.out).toContain(MY_COPY);
        expect(harness.out).toContain('2 dev copies');
    });
});

describe('PushDevCommand — --resolve', () => {
    beforeEach((): void => {
        harness.remoteShas.set(MY_COPY, 'abc123');
        harness.copies = [
            new DevCopy('dev-include/amy/ONE-9', 'aaaaaaaa11', 'amy/ONE-9'),
            new DevCopy(MY_COPY, 'bbbbbbbb22', 'dean/ONE-2275'),
            new DevCopy('dev-include/zoe/ONE-1', 'cccccccc33', 'zoe/ONE-1'),
        ];
    });

    it('queues every OTHER copy, in CI composition order, starting from the published copy', async (): Promise<void> => {
        const opts = options();
        opts.resolve = true;
        await run(opts);
        expect(harness.startedState?.queue).toEqual(['dev-include/amy/ONE-9', 'dev-include/zoe/ONE-1']);
        expect(harness.startedBase).toBe(`refs/remotes/origin/${MY_COPY}`);
    });

    it('queues only the named branch, with or without the namespace prefix', async (): Promise<void> => {
        const opts = options();
        opts.resolve = true;
        opts.resolveTarget = 'zoe/ONE-1';
        await run(opts);
        expect(harness.startedState?.queue).toEqual(['dev-include/zoe/ONE-1']);
    });

    it('refuses a branch that has no published copy, listing what there is', async (): Promise<void> => {
        const opts = options();
        opts.resolve = true;
        opts.resolveTarget = 'nobody/ONE-0';
        const message = await refusalMessage(opts);
        expect(message).toContain('No published copy `dev-include/nobody/ONE-0`');
        expect(message).toContain('dev-include/amy/ONE-9');
    });

    it('refuses to resolve before the branch has ever been published', async (): Promise<void> => {
        harness.remoteShas = new Map<string, string>();
        const opts = options();
        opts.resolve = true;
        expect(await refusalMessage(opts)).toContain('is not published yet');
    });

    it('says there is nothing to compose when it is the only copy', async (): Promise<void> => {
        harness.copies = [new DevCopy(MY_COPY, 'bbbbbbbb22', 'dean/ONE-2275')];
        const opts = options();
        opts.resolve = true;
        await run(opts);
        expect(harness.startedState).toBeNull();
        expect(harness.out).toContain('Nothing to compose');
    });
});
