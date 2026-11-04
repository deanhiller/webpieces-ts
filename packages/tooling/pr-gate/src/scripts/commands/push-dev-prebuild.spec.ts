import { ProcessCallDto, ScriptedShellRun, specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildsLog, BuildTermination, BuildTicket, CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { DotWebpieces, GitResultDto } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { RepoConfigFixture } from '../workflow/repo-config-testkit';
import { PushDevStateStore } from '../workflow/push-dev-state';

import { PrGateApp } from '../pr-gate-app';
import { PushDevOptions } from './push-dev-command';
import { FinishPushDevOptions } from './finish-push-dev-command';

/**
 * Feature tests for #1397: `wp-push-dev` checks the copy against `origin/dev` on a THROWAWAY merge, runs
 * `commands.push-dev.buildCommand` on the merged tree, and only then publishes — and what it publishes is
 * never that merge. `wp-build-dev` is the same check without the publish.
 *
 * The whole shipped container runs (`PrGateApp` from `PrGateContainer`), over a temp checkout carrying
 * this repo's own config with a `commands.push-dev` block added. Only the edges are scripted: git (the
 * remote's refs, which merges conflict, which files are unmerged), the build's shell command, and the
 * build ledger's HOME. Every assertion is on what LEFT the program: the git commands it issued, the build
 * it ran, what it printed, the exit it threw.
 */

const BRANCH = 'dean/ONE-2275';
const COPY = 'dev-include/dean/ONE-2275';
const TMP = 'dean/ONE-2275DevResolve';
const CHECK_TMP = 'dean/ONE-2275DevCheck';
const FEATURE_SHA = '1111111111111111111111111111111111111111';
const MERGED_SHA = '2222222222222222222222222222222222222222';
const RESOLVED_SHA = '3333333333333333333333333333333333333333';
const DEV_SHA = '4444444444444444444444444444444444444444';
const COPY_SHA = '5555555555555555555555555555555555555555';
const DEV_BUILD = 'pnpm nx affected --target=ci --base=origin/dev --head=HEAD';

const dirs: string[] = [];

/** The REAL ledger code, pointed at a throwaway HOME so no row lands in the developer's own one. */
class TempHomeBuildsLog extends BuildsLog {
    constructor(private readonly home: string) {
        super(new DotWebpieces());
    }

    override start(by: string, startDir: string): BuildTicket {
        return super.start(by, startDir, this.home);
    }

    override finish(ticket: BuildTicket, termination: BuildTermination): void {
        super.finish(ticket, termination, this.home);
    }
}

class FixedRoot extends RepoRootFinder {
    constructor(private readonly root: string) {
        super();
    }

    override resolveRepoRoot(): string {
        return this.root;
    }
}

/** What one run left behind: the CliExitError it threw (null when it completed) and what it printed. */
class Outcome {
    constructor(readonly thrown: CliExitError | null, readonly out: string) {}
}

/** What the outside world looks like for one test. */
class World {
    devExists = true;
    copySha = '';
    remoteOnlySubjects: string[] = [];
    /** Refs (as merged, `refs/remotes/origin/<x>`) whose merge conflicts. */
    conflicting = new Set<string>();
    unmerged: string[] = [];
    /** Did the resolution actually change anything relative to the base? */
    resolutionChangesBase = true;
    tmpSha = MERGED_SHA;
    /** How the dev build exits, and what it writes into its log. */
    buildExit = 0;
    buildOutput = 'all green\n';
}

let feature: PrGateFeature;
let repo: string;
let world: World;

function makeRepo(withDevBuild: boolean): string {
    const dir = specTempDirs.makeReal('wp-push-dev-prebuild-');
    dirs.push(dir);
    const fixture = new RepoConfigFixture();
    const config = fixture.load();
    // webpieces-disable no-any-unknown -- narrowing one nested section
    const commands = config['commands'] as Record<string, unknown>;
    if (withDevBuild) commands['push-dev'] = { buildCommand: DEV_BUILD };
    else delete commands['push-dev'];
    fixture.writeTo(dir, config);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${BRANCH}\n`);
    return dir;
}

/** git, answered from `world`. Anything not named here succeeds silently, as an ordinary write would. */
function scriptGit(): void {
    const git = feature.git;
    git.respond(['status', '--porcelain'], git.ok(''));
    git.respond(['ls-files', '--others', '--exclude-standard'], git.ok(''));
    git.respondToPrefix(['ls-remote', '--heads', 'origin'], (call: ProcessCallDto): GitResultDto => {
        const asked = call.args[3];
        if (asked === 'dev') return git.ok(world.devExists ? `${DEV_SHA}\trefs/heads/dev\n` : '');
        if (asked === COPY) return git.ok(world.copySha === '' ? '' : `${world.copySha}\trefs/heads/${COPY}\n`);
        return git.ok('');
    });
    git.respondToPrefix(['log', '--format=%s'], (): GitResultDto => git.ok(world.remoteOnlySubjects.join('\n')));
    git.respondToPrefix(['-C', repo], (call: ProcessCallDto): GitResultDto => {
        const args = call.args;
        if (args[2] === 'merge' && !args.includes('--abort')) {
            return world.conflicting.has(args[args.length - 1]) ? git.fail(1, 'CONFLICT (content): Merge conflict') : git.ok();
        }
        if (args.includes('--diff-filter=U')) return git.ok(world.unmerged.join('\n'));
        if (args[2] === 'diff' && args.includes('--cached')) return world.resolutionChangesBase ? git.fail(1) : git.ok();
        if (args[2] === 'rev-parse') return git.ok(`${shaOf(args[3])}\n`);
        if (args[2] === 'checkout' && args[3] === '-B') world.tmpSha = shaOf(args[5]);
        if (args[2] === 'commit' && args.join(' ').includes('conflict resolution')) world.tmpSha = RESOLVED_SHA;
        return git.ok();
    });
}

// What `git rev-parse <ref>` answers.
function shaOf(ref: string): string {
    if (ref === 'HEAD' || ref === BRANCH) return FEATURE_SHA;
    if (ref === `refs/remotes/origin/${COPY}`) return COPY_SHA;
    if (ref === TMP || ref === CHECK_TMP) return world.tmpSha;
    return ref;
}

const app = (): PrGateApp => feature.container.get(PrGateApp);

/** Run `body`; return the CliExitError it threw (null when it completed) and everything it printed. */
async function run(body: () => Promise<void>): Promise<Outcome> {
    const captured = CapturedOutput.start();
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: stdout MUST be restored, and the CliExitError IS the assertion
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await body();
        return new Outcome(null, captured.stdout);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof CliExitError) return new Outcome(error, captured.stdout);
        throw error;
    } finally {
        captured.stop();
    }
}

function publish(opts: PushDevOptions = new PushDevOptions()): Promise<Outcome> {
    return run((): Promise<void> => app().pushDev(opts));
}

/** Every git command line, in order, as a person would type it (without the `-C <repo>`). */
function gitLines(): string[] {
    return feature.git.calls.map((c: ProcessCallDto): string =>
        (c.args[0] === '-C' ? c.args.slice(2) : c.args).join(' '));
}

const indexOf = (prefix: string): number => gitLines().findIndex((l: string): boolean => l.startsWith(prefix));
const pushes = (): string[] => gitLines().filter((l: string): boolean => l.startsWith('push'));
const builds = (): number => feature.processes.shellCalls.length;
// The cardinal rule: no WRITE ever names the feature branch; going back to it is the one legitimate mention.
const writesToFeatureBranch = (): boolean =>
    gitLines().some((l: string): boolean => l.split(' ').includes(BRANCH) && !l.startsWith('checkout') && !l.startsWith('rev-parse'));

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
    world = new World();
    repo = makeRepo(true);
    const home = specTempDirs.makeReal('wp-push-dev-home-');
    dirs.push(home);
    (await feature.container.rebind(BuildsLog)).toConstantValue(new TempHomeBuildsLog(home));
    (await feature.container.rebind(RepoRootFinder)).toConstantValue(new FixedRoot(repo));
    scriptGit();
    feature.processes.respondToShell(DEV_BUILD, (): ScriptedShellRun => feature.processes.exited(world.buildExit, world.buildOutput));
});

afterEach((): void => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('wp-push-dev — the check against dev before publishing', () => {
    it('merges origin/dev into a throwaway, builds it, then publishes the UN-merged feature head', async (): Promise<void> => {
        const r = await publish();
        expect(r.thrown).toBeNull();
        const fetchDev = indexOf('fetch origin +refs/heads/dev:refs/remotes/origin/dev');
        const merge = indexOf('merge --no-ff --no-edit -m Dev-deploy: merge dev into');
        const reset = gitLines().indexOf(`checkout -B ${TMP} ${FEATURE_SHA}`);
        const push = indexOf('push');
        expect(fetchDev).toBeGreaterThanOrEqual(0);
        expect(fetchDev).toBeLessThan(merge);
        expect(merge).toBeLessThan(reset);
        // The throwaway is moved BACK to the feature head before the push: the merge is never published.
        expect(reset).toBeLessThan(push);
        expect(pushes()).toEqual([`push origin ${TMP}:refs/heads/${COPY}`]);
        expect(feature.processes.shellCalls.map((c: ProcessCallDto): string => c.args[0])).toEqual([DEV_BUILD]);
        expect(gitLines().some((l: string): boolean => l.startsWith('commit'))).toBe(false);
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(writesToFeatureBranch()).toBe(false);
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
        expect(r.out).toContain('Checking dev-include/dean/ONE-2275 against origin/dev before publishing');
        expect(r.out).toContain('FullLog');
        expect(r.out).toContain(`git merge-base --is-ancestor ${FEATURE_SHA} origin/dev`);
    });

    it('a red dev build publishes nothing and puts the checkout back on the feature branch', async (): Promise<void> => {
        world.buildExit = 1;
        world.buildOutput = 'error TS2304: Cannot find name\n';
        const r = await publish();
        expect(r.thrown?.message).toContain('Dev build failed — nothing was published.');
        expect(r.thrown?.message).toContain(`Build Failed: ${DEV_BUILD}`);
        expect(r.thrown?.message).toContain('error TS2304');
        expect(pushes()).toEqual([]);
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
    });

    it('refuses before touching anything when commands.push-dev.buildCommand is not configured', async (): Promise<void> => {
        repo = makeRepo(false);
        (await feature.container.rebind(RepoRootFinder)).toConstantValue(new FixedRoot(repo));
        scriptGit();
        const r = await publish();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('`commands.push-dev.buildCommand` is not configured');
        expect(r.thrown?.message).toContain(`"push-dev": { "buildCommand": "${DEV_BUILD}" }`);
        expect(r.thrown?.message).toContain('there is no default');
        expect(gitLines().filter((l: string): boolean => /^(merge|checkout|push|fetch)/.test(l))).toEqual([]);
        expect(builds()).toBe(0);
    });

    it('leases the push against the copy it inspected', async (): Promise<void> => {
        world.copySha = 'abc123';
        await publish();
        expect(pushes()).toEqual([`push --force-with-lease=refs/heads/${COPY}:abc123 origin ${TMP}:refs/heads/${COPY}`]);
    });

    it('replaces a resolution commit the flow wrote itself — the check re-derives it — without --force', async (): Promise<void> => {
        world.copySha = 'abc123';
        world.remoteOnlySubjects = [`Dev-deploy: conflict resolution for ${COPY}`];
        const r = await publish();
        expect(r.thrown).toBeNull();
        expect(pushes()).toHaveLength(1);
    });

    it('still refuses to clobber any OTHER commit only the copy has', async (): Promise<void> => {
        world.copySha = 'abc123';
        world.remoteOnlySubjects = [`Dev-deploy: conflict resolution for ${COPY}`, 'Dev-deploy: merge dev-include/amy/ONE-9 into x'];
        const r = await publish();
        expect(r.thrown?.message).toContain('holds 1 commit(s) your branch does not');
        expect(pushes()).toEqual([]);
    });

    it('publishes unchecked when origin/dev does not exist yet, so the first composition can start', async (): Promise<void> => {
        world.devExists = false;
        const r = await publish();
        expect(r.thrown).toBeNull();
        expect(pushes()).toEqual([`push origin HEAD:refs/heads/${COPY}`]);
        expect(builds()).toBe(0);
        expect(r.out).toContain('`origin/dev` does not exist yet');
    });
});

describe('wp-push-dev — a conflict with dev', () => {
    beforeEach((): void => {
        world.conflicting = new Set<string>(['refs/remotes/origin/dev']);
        world.unmerged = ['services/a/responsibilities.md'];
    });

    it('stops on the throwaway, lists the files, and neither builds nor publishes', async (): Promise<void> => {
        const r = await publish();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('CONFLICT merging dev');
        expect(r.thrown?.message).toContain('services/a/responsibilities.md');
        expect(r.thrown?.message).toContain('run the dev build, publish the copy');
        expect(pushes()).toEqual([]);
        expect(builds()).toBe(0);
        expect(writesToFeatureBranch()).toBe(false);
        expect(feature.container.get(PushDevStateStore).read(repo)?.resolvedPaths).toEqual(['services/a/responsibilities.md']);
    });

    it('wp-finish-push-dev builds, then publishes the feature head plus ONE commit holding only the resolved file', async (): Promise<void> => {
        await publish();
        world.unmerged = [];
        world.tmpSha = MERGED_SHA;
        const r = await run((): Promise<void> => app().finishPushDev(new FinishPushDevOptions(false)));
        expect(r.thrown).toBeNull();
        expect(builds()).toBe(1);
        const lines = gitLines();
        const steps = [
            lines.indexOf('commit --no-edit'),
            lines.indexOf(`checkout -B ${TMP} ${FEATURE_SHA}`),
            lines.indexOf(`checkout ${MERGED_SHA} -- services/a/responsibilities.md`),
            lines.findIndex((l: string): boolean => l.startsWith(`commit -m Dev-deploy: conflict resolution for ${COPY}`)),
            indexOf('push'),
        ];
        // Commit the merge, move the throwaway back to the feature head, take ONLY the resolved file from
        // the merge, commit that, push — in that order.
        expect(steps.every((i: number): boolean => i >= 0)).toBe(true);
        expect(steps).toEqual([...steps].sort((a: number, b: number): number => a - b));
        expect(pushes()).toEqual([`push origin ${TMP}:refs/heads/${COPY}`]);
        expect(r.out).toContain('ONE commit recording the resolution of 1 file(s)');
        expect(r.out).toContain(`git merge-base --is-ancestor ${RESOLVED_SHA} origin/dev`);
        expect(writesToFeatureBranch()).toBe(false);
    });

    it('a resolution identical to the feature head records no commit', async (): Promise<void> => {
        await publish();
        world.unmerged = [];
        world.resolutionChangesBase = false;
        await run((): Promise<void> => app().finishPushDev(new FinishPushDevOptions(false)));
        expect(gitLines().some((l: string): boolean => l.includes('conflict resolution'))).toBe(false);
        expect(pushes()).toHaveLength(1);
    });
});

describe('wp-push-dev --resolve — no other copy ever becomes an ancestor of this one', () => {
    beforeEach((): void => {
        world.copySha = COPY_SHA;
        feature.git.respondToPrefix(['ls-remote', '--heads', 'origin', 'dev-include/*'], feature.git.ok(
            `aaaaaaaa\trefs/heads/dev-include/amy/ONE-9\n${COPY_SHA}\trefs/heads/${COPY}\n`));
    });

    it('a clean composition publishes nothing — CI composes the copy as it is', async (): Promise<void> => {
        const opts = new PushDevOptions();
        opts.resolve = true;
        const r = await publish(opts);
        expect(r.thrown).toBeNull();
        expect(pushes()).toEqual([]);
        expect(builds()).toBe(0);
        expect(r.out).toContain('composes cleanly — nothing to publish');
    });

    it('a resolved conflict publishes the copy plus one resolution commit, never the merge', async (): Promise<void> => {
        world.conflicting = new Set<string>(['refs/remotes/origin/dev-include/amy/ONE-9']);
        world.unmerged = ['src/shared.ts'];
        const opts = new PushDevOptions();
        opts.resolve = true;
        await publish(opts);
        world.unmerged = [];
        world.tmpSha = MERGED_SHA;
        const r = await run((): Promise<void> => app().finishPushDev(new FinishPushDevOptions(false)));
        expect(r.thrown).toBeNull();
        const lines = gitLines();
        const reset = lines.indexOf(`checkout -B ${TMP} ${COPY_SHA}`);
        expect(reset).toBeGreaterThan(lines.indexOf('commit --no-edit'));
        expect(lines).toContain(`checkout ${MERGED_SHA} -- src/shared.ts`);
        expect(reset).toBeLessThan(indexOf('push'));
        expect(pushes()).toEqual([`push --force origin ${TMP}:refs/heads/${COPY}`]);
        // --resolve has never built; the dev build belongs to the publish of the feature head.
        expect(builds()).toBe(0);
    });
});

describe('wp-build-dev — the same check, without the publish', () => {
    it('merges origin/dev into a throwaway, builds it, goes back, and pushes nothing', async (): Promise<void> => {
        const r = await run((): Promise<void> => app().buildDev());
        expect(r.thrown).toBeNull();
        expect(indexOf('fetch origin +refs/heads/dev:refs/remotes/origin/dev')).toBeLessThan(indexOf('merge'));
        expect(gitLines()).toContain(`checkout -B ${CHECK_TMP} HEAD`);
        expect(builds()).toBe(1);
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(gitLines()).toContain(`branch -D ${CHECK_TMP}`);
        expect(pushes()).toEqual([]);
        expect(writesToFeatureBranch()).toBe(false);
        expect(r.out).toContain('merges cleanly with origin/dev and the dev build is green');
    });

    it('a conflict aborts the throwaway merge, names the files and wp-push-dev, and builds nothing', async (): Promise<void> => {
        world.conflicting = new Set<string>(['refs/remotes/origin/dev']);
        world.unmerged = ['src/a.ts'];
        const r = await run((): Promise<void> => app().buildDev());
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('CONFLICTS with origin/dev');
        expect(r.thrown?.message).toContain('src/a.ts');
        expect(r.thrown?.message).toContain('pnpm wp-push-dev');
        expect(gitLines()).toContain('merge --abort');
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(builds()).toBe(0);
    });

    it('a red build still puts the checkout back', async (): Promise<void> => {
        world.buildExit = 2;
        world.buildOutput = 'boom\n';
        const r = await run((): Promise<void> => app().buildDev());
        expect(r.thrown?.message).toContain('Fix what that log shows, then re-run pnpm wp-build-dev.');
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(pushes()).toEqual([]);
    });

    it('refuses without commands.push-dev.buildCommand', async (): Promise<void> => {
        repo = makeRepo(false);
        (await feature.container.rebind(RepoRootFinder)).toConstantValue(new FixedRoot(repo));
        scriptGit();
        const r = await run((): Promise<void> => app().buildDev());
        expect(r.thrown?.message).toContain('`commands.push-dev.buildCommand` is not configured');
        expect(gitLines().filter((l: string): boolean => /^(merge|checkout)/.test(l))).toEqual([]);
    });
});
