import { ProcessCallDto, ScriptedShellRun, specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildsLog, BuildTermination, BuildTicket, CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { MutationVerb } from '@webpieces/repo-workflow-core';
import { DotWebpieces, GitResultDto, ProcessResultDto } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { RepoConfigFixture } from '../workflow/repo-config-testkit';
import { PushDevStateStore } from '../workflow/push-dev-state';
import { VerifiedDevCopyStore } from '../workflow/verified-dev-copy';
import { RunUpdate, UpdateOutcome } from '../workflow/run-update';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { MergeState } from '../workflow/merge-state';
import { MergeStart } from '../workflow/merge-start';
import { MergeEnd } from '../workflow/merge-end';

import { PrGateApp } from '../pr-gate-app';
import { BuildPushDevOptions } from './build-push-dev-command';
import { FinishPushDevOptions } from './finish-push-dev-command';

/**
 * Feature tests for the three-stage dev-deploy flow (#1403):
 *
 *   ① `wp-start-push-dev`  — the 3-point merge from main, ONLY when the branch is behind it;
 *   ② `wp-build-push-dev`  — the PR gate's build on the branch alone (code rules vs main, #1405), then merge
 *                            origin/dev into a THROWAWAY (conflicts caused only by copies already on main take
 *                            the publisher's side, #1405), `pnpm install`, the dev build, record the copy;
 *   ③ `wp-finish-push-dev` — publish exactly the copy ② recorded (plus `--list` and `--remove`).
 *
 * The whole shipped container runs (`PrGateApp` from `PrGateContainer`), over a temp checkout carrying this
 * repo's own config with a `commands.push-dev` block added. Only the edges are scripted: git (the remote's
 * refs, which merges conflict, which files are unmerged), `pnpm install`, `gh`, the build's shell command,
 * and the build ledger's HOME. Every assertion is on what LEFT the program: the git commands it issued, the
 * processes it ran, what it printed, the exit it threw.
 *
 * Stage ①'s 3-point merge itself is the engine `wp-start-update` / `wp-start-upsert-pr` already run
 * (RunUpdate) and is not re-tested here: the assertion is WHEN stage ① invokes it and with what push
 * decision, so RunUpdate alone is replaced by a recorder.
 */

const BRANCH = 'dean/ONE-2275';
const COPY = 'dev-include/dean/ONE-2275';
const MARKER = 'dev-remove/dean/ONE-2275';
const TMP = 'dean/ONE-2275DevResolve';
const KEEP_REF = 'refs/webpieces/push-dev/dean/ONE-2275';
const FEATURE_SHA = '1111111111111111111111111111111111111111';
const MERGED_SHA = '2222222222222222222222222222222222222222';
const RESOLVED_SHA = '3333333333333333333333333333333333333333';
const DEV_SHA = '4444444444444444444444444444444444444444';
const MAIN_TIP = '6666666666666666666666666666666666666666';
const DEV_BUILD = 'pnpm nx affected -t build test --base=origin/dev --head=HEAD';
const MAIN_BUILD = 'pnpm wp-ci --base=$(git merge-base origin/main HEAD)';
const LANDED = 'dev-include/amy/ONE-4073';
const LIVE = 'dev-include/bob/ONE-5000';

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

/** RunUpdate's one call, as stage ① made it. */
class UpdateCall {
    constructor(readonly verb: MutationVerb, readonly finishCommand: string, readonly pushRemote: boolean) {}
}

/** The reused 3-point merge engine, replaced by a recorder (see the file comment). */
class RecordingRunUpdate extends RunUpdate {
    calls: UpdateCall[] = [];
    outcome: UpdateOutcome = 'finalized';

    override async runUpdateFromMain(_repoRoot: string, verb: MutationVerb, finishCommand: string, pushRemote: boolean): Promise<UpdateOutcome> {
        this.calls.push(new UpdateCall(verb, finishCommand, pushRemote));
        return this.outcome;
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
    containsMain = true;
    headSha = FEATURE_SHA;
    /** Refs (as merged, `refs/remotes/origin/<x>`) whose merge conflicts. */
    conflicting = new Set<string>();
    unmerged: string[] = [];
    /** Did the resolution actually change anything relative to the base? */
    resolutionChangesBase = true;
    tmpSha = MERGED_SHA;
    onBranch = BRANCH;
    installExit = 0;
    buildExit = 0;
    buildOutput = 'all green\n';
    openPr = '';
    /** `--remove`'s content check: what the copy changes vs. what still differs from main. */
    copyChanged: string[] = ['services/a/src/a.ts'];
    stillDiffer: string[] = ['services/a/src/a.ts', 'services/z/other-work-on-main.ts'];
    copies: string[] = [];
    /** Builds that had run when `pnpm install` was called — must be 0, install comes first. */
    buildsAtInstall: number[] = [];
    mainBuildExit = 0;
    /** How many git commands had been issued when the build against main ran. */
    gitCallsAtMainBuild: number[] = [];
    /** Per copy ref: the files it changes since its merge-base with main (else `copyChanged`). */
    copyChangedBy = new Map<string, string[]>();
    /** Per copy ref: the files where main and the copy still differ (else `stillDiffer`). */
    stillDifferBy = new Map<string, string[]>();
    /** Files the publisher's branch (HEAD of the throwaway) does not have. */
    deletedInHead: string[] = [];
    /** Per copy's source branch: its merged PR number ('' = none). */
    mergedPrs = new Map<string, string>();
}

let feature: PrGateFeature;
let repo: string;
let world: World;
let runUpdate: RecordingRunUpdate;

function makeRepo(withDevBuild: boolean): string {
    const dir = specTempDirs.makeReal('wp-push-dev-stages-');
    dirs.push(dir);
    const fixture = new RepoConfigFixture();
    const config = fixture.load();
    // webpieces-disable no-any-unknown -- narrowing one nested section
    const commands = config['commands'] as Record<string, unknown>;
    // webpieces-disable no-any-unknown -- narrowing one nested section
    (commands['pr-gate'] as Record<string, unknown>)['buildCommand'] = MAIN_BUILD;
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
    git.respond(['branch', '--show-current'], (): GitResultDto => git.ok(world.onBranch));
    git.respondToPrefix(['ls-remote', '--heads', 'origin'], (call: ProcessCallDto): GitResultDto => {
        const asked = call.args[3];
        if (asked.endsWith('*')) return git.ok(world.copies.map((c: string): string => `abcdef12\trefs/heads/${c}\n`).join(''));
        if (asked === 'dev') return git.ok(world.devExists ? `${DEV_SHA}\trefs/heads/dev\n` : '');
        if (asked === COPY) return git.ok(world.copySha === '' ? '' : `${world.copySha}\trefs/heads/${COPY}\n`);
        return git.ok('');
    });
    git.respondToPrefix(['-C', repo], (call: ProcessCallDto): GitResultDto => {
        const args = call.args;
        if (args[2] === 'merge-base') return world.containsMain ? git.ok() : git.fail(1);
        if (args[2] === 'merge' && !args.includes('--abort')) {
            return world.conflicting.has(args[args.length - 1]) ? git.fail(1, 'CONFLICT (content): Merge conflict') : git.ok();
        }
        if (args.includes('--diff-filter=U')) return git.ok(world.unmerged.join('\n'));
        if (args[2] === 'diff' && args.includes('--no-renames')) {
            const threeDot = args.find((a: string): boolean => a.includes('...'));
            const copy = (threeDot ?? args[args.length - 1]).split('refs/remotes/origin/').pop() ?? '';
            const files = threeDot !== undefined
                ? world.copyChangedBy.get(copy) ?? world.copyChanged
                : world.stillDifferBy.get(copy) ?? world.stillDiffer;
            return git.ok(files.join('\n'));
        }
        if (args[2] === 'cat-file' && args[4].startsWith('HEAD:')) {
            return world.deletedInHead.includes(args[4].slice('HEAD:'.length)) ? git.fail(1) : git.ok();
        }
        if (args[2] === 'diff' && args.includes('--cached')) return world.resolutionChangesBase ? git.fail(1) : git.ok();
        if (args[2] === 'rev-parse') return git.ok(`${shaOf(args[3])}\n`);
        if (args[2] === 'checkout' && args[3] === '-B') {
            world.tmpSha = shaOf(args[5]);
            world.onBranch = args[4];
        } else if (args[2] === 'checkout' && args.length === 4) {
            world.onBranch = args[3];
        }
        if (args[2] === 'commit' && args.join(' ').includes('conflict resolution')) world.tmpSha = RESOLVED_SHA;
        return git.ok();
    });
}

// What `git rev-parse <ref>` answers.
function shaOf(ref: string): string {
    if (ref === 'HEAD' || ref === BRANCH) return world.headSha;
    if (ref === TMP) return world.tmpSha;
    if (ref === 'refs/remotes/origin/dev') return DEV_SHA;
    if (ref === 'refs/remotes/origin/main') return MAIN_TIP;
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

const start = (): Promise<Outcome> => run((): Promise<void> => app().startPushDev());
const build = (abort = false): Promise<Outcome> => run((): Promise<void> => app().buildPushDev(new BuildPushDevOptions(abort)));

function finish(mutate: (o: FinishPushDevOptions) => void = (): void => undefined): Promise<Outcome> {
    const opts = new FinishPushDevOptions();
    mutate(opts);
    return run((): Promise<void> => app().finishPushDev(opts));
}

/** Every git command line, in order, as a person would type it (without the `-C <repo>`). */
function gitLines(): string[] {
    return feature.git.calls.map((c: ProcessCallDto): string =>
        (c.args[0] === '-C' ? c.args.slice(2) : c.args).join(' '));
}

const indexOf = (prefix: string): number => gitLines().findIndex((l: string): boolean => l.startsWith(prefix));
const pushes = (): string[] => gitLines().filter((l: string): boolean => l.startsWith('push'));
const builds = (): number => feature.processes.shellCalls.filter((c: ProcessCallDto): boolean => c.args[0] === DEV_BUILD).length;
const mainBuilds = (): number => feature.processes.shellCalls.filter((c: ProcessCallDto): boolean => c.args[0] === MAIN_BUILD).length;
const installs = (): number => feature.processes.callsStartingWith('pnpm', ['install']).length;
const verifiedRecord = (): ReturnType<VerifiedDevCopyStore['read']> => feature.container.get(VerifiedDevCopyStore).read(repo);
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
    const c = feature.container;
    runUpdate = new RecordingRunUpdate(c.get(AiBranchName), c.get(MergeState), c.get(MergeStart), c.get(MergeEnd));
    (await feature.container.rebind(RunUpdate)).toConstantValue(runUpdate);
    scriptGit();
    feature.processes.respond('pnpm', ['install'], (): ProcessResultDto => {
        world.buildsAtInstall.push(builds());
        return feature.processes.fail(world.installExit, '');
    });
    feature.processes.respondToPrefix('gh', ['pr', 'list', '--head', BRANCH, '--state', 'open'],
        (): ProcessResultDto => feature.processes.ok(world.openPr));
    feature.processes.respondToShell(DEV_BUILD, (): ScriptedShellRun => feature.processes.exited(world.buildExit, world.buildOutput));
    feature.processes.respondToPrefix('gh', ['pr', 'list', '--head'], (call: ProcessCallDto): ProcessResultDto => {
        const pr = world.mergedPrs.get(call.args[3]) ?? '';
        return feature.processes.ok(pr === '' ? 'null null\n' : `${pr} 2026-11-04T12:22:00Z\n`);
    });
    feature.processes.respondToShell(MAIN_BUILD, (): ScriptedShellRun => {
        world.gitCallsAtMainBuild.push(feature.git.calls.length);
        return feature.processes.exited(world.mainBuildExit, world.mainBuildExit === 0 ? 'rules green\n' : 'max-method-lines: 385 > 80\n');
    });
});

/** `gh pr list --head <branch> --state merged` for a copy's branch: `pr` = '' means no merged PR. */
function mergedPrOf(branch: string, pr: string): void {
    world.mergedPrs.set(branch, pr);
}

afterEach((): void => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('① wp-start-push-dev — the 3-point merge from main, only when behind', () => {
    it('does nothing to a branch that already contains origin/main, and names stage ②', async (): Promise<void> => {
        const r = await start();
        expect(r.thrown).toBeNull();
        expect(gitLines()).toContain('fetch origin +refs/heads/main:refs/remotes/origin/main');
        expect(gitLines()).toContain('merge-base --is-ancestor refs/remotes/origin/main HEAD');
        expect(runUpdate.calls).toEqual([]);
        expect(r.out).toContain('already contains origin/main — nothing to merge');
        expect(r.out).toContain('NEXT run:  pnpm wp-build-push-dev');
    });

    it('a branch behind main with no PR runs the shared 3-point merge, pushing like wp-start-update', async (): Promise<void> => {
        world.containsMain = false;
        const r = await start();
        expect(r.thrown).toBeNull();
        expect(runUpdate.calls).toEqual([new UpdateCall('wp-start-push-dev', 'wp-build-push-dev', true)]);
        expect(r.out).toContain('Updated from main');
        expect(r.out).toContain('NEXT run:  pnpm wp-build-push-dev');
    });

    it('with a PR open the rewrite stays local, like wp-start-upsert-pr, and says so', async (): Promise<void> => {
        world.containsMain = false;
        world.openPr = '77';
        const r = await start();
        expect(runUpdate.calls).toEqual([new UpdateCall('wp-start-push-dev', 'wp-build-push-dev', false)]);
        expect(r.out).toContain('PR #77 is open, so the update was NOT pushed to it');
    });

    it('a conflict hands the branch to /wp-merge and names stage ② as what finalizes it', async (): Promise<void> => {
        world.containsMain = false;
        runUpdate.outcome = 'conflict';
        const r = await start();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('/wp-merge');
        expect(r.thrown?.message).toContain('pnpm wp-build-push-dev');
    });

    it('refuses main itself before fetching anything', async (): Promise<void> => {
        fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const r = await start();
        expect(r.thrown?.message).toContain('Refusing to publish a dev copy of `main`');
        expect(runUpdate.calls).toEqual([]);
    });
});

describe('② wp-build-push-dev — the check against dev', () => {
    it('merges origin/dev into a throwaway, installs, builds, records the UN-merged feature head, and pushes nothing', async (): Promise<void> => {
        const r = await build();
        expect(r.thrown).toBeNull();
        const fetchDev = indexOf('fetch origin +refs/heads/dev:refs/remotes/origin/dev');
        const merge = indexOf('merge --no-ff --no-edit -m Dev-deploy: merge dev into');
        const reset = gitLines().indexOf(`checkout -B ${TMP} ${FEATURE_SHA}`);
        expect(fetchDev).toBeGreaterThanOrEqual(0);
        expect(fetchDev).toBeLessThan(merge);
        // The throwaway is moved BACK to the feature head: the merge is never what gets published.
        expect(merge).toBeLessThan(reset);
        expect(installs()).toBe(1);
        expect(world.buildsAtInstall).toEqual([0]);
        expect(builds()).toBe(1);
        // The PR gate's build ran on the feature branch, before dev was even fetched (#1405).
        expect(mainBuilds()).toBe(1);
        expect(world.gitCallsAtMainBuild[0]).toBeLessThanOrEqual(fetchDev);
        expect(pushes()).toEqual([]);
        expect(gitLines()).toContain(`update-ref ${KEEP_REF} ${FEATURE_SHA}`);
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(writesToFeatureBranch()).toBe(false);
        expect(verifiedRecord()).toMatchObject({ branch: BRANCH, headSha: FEATURE_SHA, copySha: FEATURE_SHA, targetRef: COPY, leaseSha: '', devSha: DEV_SHA });
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
        expect(r.out).toContain('Checking dev-include/dean/ONE-2275 against origin/dev');
        expect(r.out).toContain('FullLog');
        expect(r.out).toContain('NEXT run:  pnpm wp-finish-push-dev');
    });

    it('refuses a branch behind origin/main, naming stage ①, before merging anything', async (): Promise<void> => {
        world.containsMain = false;
        const r = await build();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('is behind origin/main');
        expect(r.thrown?.message).toContain('pnpm wp-start-push-dev');
        expect(indexOf('merge --no-ff')).toBe(-1);
        expect(builds()).toBe(0);
        expect(mainBuilds()).toBe(0);
        expect(verifiedRecord()).toBeNull();
    });

    it('a red build against main (the code rules) stops before dev is fetched, merged or built', async (): Promise<void> => {
        world.mainBuildExit = 1;
        const r = await build();
        expect(r.thrown?.message).toContain(`Build Failed: ${MAIN_BUILD}`);
        expect(r.thrown?.message).toContain('Fix what that log shows, then re-run pnpm wp-build-push-dev.');
        expect(indexOf('fetch origin +refs/heads/dev:refs/remotes/origin/dev')).toBe(-1);
        expect(indexOf('merge --no-ff')).toBe(-1);
        expect(installs()).toBe(0);
        expect(builds()).toBe(0);
        expect(verifiedRecord()).toBeNull();
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
    });

    it('a failed pnpm install builds nothing, records nothing, and puts the checkout back', async (): Promise<void> => {
        world.installExit = 1;
        const r = await build();
        expect(r.thrown?.message).toContain('pnpm install failed on the merge with origin/dev');
        expect(builds()).toBe(0);
        expect(verifiedRecord()).toBeNull();
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(gitLines()).toContain('reset --hard HEAD');
    });

    it('a red dev build records nothing and puts the checkout back on the feature branch', async (): Promise<void> => {
        world.buildExit = 1;
        world.buildOutput = 'error TS2304: Cannot find name\n';
        const r = await build();
        expect(r.thrown?.message).toContain(`Build Failed: ${DEV_BUILD}`);
        expect(r.thrown?.message).toContain('Fix what that log shows, then re-run pnpm wp-build-push-dev.');
        expect(verifiedRecord()).toBeNull();
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
    });

    it('refuses before touching anything when commands.push-dev.buildCommand is not configured', async (): Promise<void> => {
        repo = makeRepo(false);
        (await feature.container.rebind(RepoRootFinder)).toConstantValue(new FixedRoot(repo));
        scriptGit();
        const r = await build();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('`commands.push-dev.buildCommand` is not configured');
        expect(r.thrown?.message).toContain(`"push-dev": { "buildCommand": "${DEV_BUILD}" }`);
        expect(gitLines().filter((l: string): boolean => /^(merge|checkout|push|fetch)/.test(l))).toEqual([]);
        expect(builds()).toBe(0);
    });

    it('records the copy sha it saw as the lease stage ③ pushes with', async (): Promise<void> => {
        world.copySha = 'abc123';
        await build();
        expect(verifiedRecord()?.leaseSha).toBe('abc123');
    });

    it('records the branch unchecked when origin/dev does not exist yet, so the first composition can start', async (): Promise<void> => {
        world.devExists = false;
        const r = await build();
        expect(r.thrown).toBeNull();
        expect(builds()).toBe(0);
        expect(mainBuilds()).toBe(1);
        expect(pushes()).toEqual([]);
        expect(verifiedRecord()).toMatchObject({ copySha: FEATURE_SHA, devSha: '' });
        expect(r.out).toContain('`origin/dev` does not exist yet');
    });
});

describe('② wp-build-push-dev — a conflict with dev', () => {
    beforeEach((): void => {
        world.conflicting = new Set<string>(['refs/remotes/origin/dev']);
        world.unmerged = ['services/a/responsibilities.md'];
    });

    it('stops on the throwaway, lists the files, and neither installs, builds nor records', async (): Promise<void> => {
        const r = await build();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('CONFLICT merging origin/dev');
        expect(r.thrown?.message).toContain('services/a/responsibilities.md');
        expect(r.thrown?.message).toContain('pnpm wp-build-push-dev --abort');
        expect(installs()).toBe(0);
        expect(builds()).toBe(0);
        expect(verifiedRecord()).toBeNull();
        expect(writesToFeatureBranch()).toBe(false);
        expect(feature.container.get(PushDevStateStore).read(repo)?.resolvedPaths).toEqual(['services/a/responsibilities.md']);
    });

    it('re-running it commits the resolution, installs, builds, and records the feature head plus ONE resolution commit', async (): Promise<void> => {
        await build();
        world.unmerged = [];
        world.tmpSha = MERGED_SHA;
        const r = await build();
        expect(r.thrown).toBeNull();
        expect(installs()).toBe(1);
        expect(builds()).toBe(1);
        // The resume continues the dev check; the build against main already passed before the merge.
        expect(mainBuilds()).toBe(1);
        const lines = gitLines();
        const steps = [
            lines.indexOf('commit --no-edit'),
            lines.indexOf(`checkout -B ${TMP} ${FEATURE_SHA}`),
            lines.indexOf(`checkout ${MERGED_SHA} -- services/a/responsibilities.md`),
            lines.findIndex((l: string): boolean => l.startsWith(`commit -m Dev-deploy: conflict resolution for ${COPY}`)),
            lines.indexOf(`update-ref ${KEEP_REF} ${RESOLVED_SHA}`),
        ];
        // Commit the merge, move the throwaway back to the feature head, take ONLY the resolved file from
        // the merge, commit that, keep it reachable — in that order.
        expect(steps.every((i: number): boolean => i >= 0)).toBe(true);
        expect(steps).toEqual([...steps].sort((a: number, b: number): number => a - b));
        expect(pushes()).toEqual([]);
        expect(verifiedRecord()).toMatchObject({ headSha: FEATURE_SHA, copySha: RESOLVED_SHA });
        expect(r.out).toContain('ONE commit recording the resolution of 1 file(s)');
        expect(writesToFeatureBranch()).toBe(false);
    });

    it('refuses to continue while a file is still unmerged', async (): Promise<void> => {
        await build();
        const r = await build();
        expect(r.thrown?.message).toContain('Conflicts are NOT resolved yet');
        expect(gitLines()).not.toContain('commit --no-edit');
    });

    it('--abort goes back to the feature branch and leaves no state', async (): Promise<void> => {
        await build();
        const r = await build(true);
        expect(r.thrown).toBeNull();
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(gitLines()).toContain(`branch -D ${TMP}`);
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
        expect(verifiedRecord()).toBeNull();
    });

    it('blocks the other stages while the resolve is half-finished', async (): Promise<void> => {
        await build();
        expect((await start()).thrown?.message).toContain('`pnpm wp-start-push-dev` is blocked');
        expect((await finish()).thrown?.message).toContain('`pnpm wp-finish-push-dev` is blocked');
    });
});

describe('② wp-build-push-dev — conflicts caused only by copies already on main (#1405)', () => {
    const FILE_A = 'services/orders/src/OrdersController.ts';
    const FILE_B = 'services/menus/src/MenuService.ts';

    beforeEach((): void => {
        world.conflicting = new Set<string>(['refs/remotes/origin/dev']);
        world.copies = [LANDED, LIVE];
        world.copyChangedBy.set(LANDED, [FILE_A]);
        world.copyChangedBy.set(LIVE, [FILE_B]);
        // Landed with DIFFERENT content (review commits, then a squash): main and the copy still differ.
        world.stillDifferBy.set(LANDED, [FILE_A]);
        world.stillDifferBy.set(LIVE, [FILE_B]);
        mergedPrOf('amy/ONE-4073', '1934');
        mergedPrOf('bob/ONE-5000', '');
    });

    it('takes the publisher\'s side when the dev side is only a landed copy, names it, and carries on', async (): Promise<void> => {
        world.unmerged = [FILE_A];
        const r = await build();
        expect(r.thrown).toBeNull();
        const lines = gitLines();
        const steps = [
            lines.indexOf(`fetch origin +refs/heads/${LANDED}:refs/remotes/origin/${LANDED} +refs/heads/${LIVE}:refs/remotes/origin/${LIVE}`),
            lines.indexOf(`checkout --ours -- ${FILE_A}`),
            lines.indexOf(`add -- ${FILE_A}`),
            lines.indexOf('commit --no-edit'),
            lines.indexOf(`checkout -B ${TMP} ${FEATURE_SHA}`),
        ];
        expect(steps.every((i: number): boolean => i >= 0)).toBe(true);
        expect(steps).toEqual([...steps].sort((a: number, b: number): number => a - b));
        expect(installs()).toBe(1);
        expect(builds()).toBe(1);
        // Nothing the developer resolved, so the copy is the branch exactly as it is: no resolution commit.
        expect(verifiedRecord()).toMatchObject({ headSha: FEATURE_SHA, copySha: FEATURE_SHA });
        expect(lines.some((l: string): boolean => l.startsWith('commit -m Dev-deploy: conflict resolution'))).toBe(false);
        expect(r.out).toContain(`${FILE_A}   ← overrode ${LANDED}`);
        expect(writesToFeatureBranch()).toBe(false);
    });

    it('also takes the publisher\'s side when main already holds the copy\'s content of the file, with no merged PR', async (): Promise<void> => {
        mergedPrOf('amy/ONE-4073', '');
        world.stillDifferBy.set(LANDED, []);
        world.unmerged = [FILE_A];
        const r = await build();
        expect(r.thrown).toBeNull();
        expect(gitLines()).toContain(`checkout --ours -- ${FILE_A}`);
        expect(r.out).toContain(`overrode ${LANDED}`);
    });

    it('keeps a file the publisher deleted deleted', async (): Promise<void> => {
        world.unmerged = [FILE_A];
        world.deletedInHead = [FILE_A];
        const r = await build();
        expect(r.thrown).toBeNull();
        expect(gitLines()).toContain(`rm -q --ignore-unmatch -- ${FILE_A}`);
        expect(gitLines()).not.toContain(`checkout --ours -- ${FILE_A}`);
    });

    it('halts on what a LIVE copy caused, listing only that, after resolving the landed one', async (): Promise<void> => {
        world.unmerged = [FILE_A, FILE_B];
        const r = await build();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('CONFLICT merging origin/dev');
        expect(r.thrown?.message).toContain(`  ${FILE_B}\n`);
        expect(r.thrown?.message).toContain(`${FILE_A}   ← overrode ${LANDED}`);
        expect(gitLines()).toContain(`checkout --ours -- ${FILE_A}`);
        expect(gitLines()).not.toContain(`checkout --ours -- ${FILE_B}`);
        expect(gitLines()).not.toContain('commit --no-edit');
        expect(builds()).toBe(0);
        expect(feature.container.get(PushDevStateStore).read(repo)?.resolvedPaths).toEqual([FILE_B]);
    });

    it('leaves a file for the developer when a live copy ALSO changes it', async (): Promise<void> => {
        world.copyChangedBy.set(LIVE, [FILE_A]);
        world.stillDifferBy.set(LIVE, [FILE_A]);
        world.unmerged = [FILE_A];
        const r = await build();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).not.toContain('overrode');
        expect(gitLines()).not.toContain(`checkout --ours -- ${FILE_A}`);
    });

    it('a merge that fails with nothing conflicted says so in git\'s words and puts the checkout back', async (): Promise<void> => {
        world.unmerged = [];
        const r = await build();
        expect(r.thrown?.exitCode).toBe(1);
        expect(r.thrown?.message).toContain('failed — and nothing conflicted');
        expect(r.thrown?.message).toContain('CONFLICT (content): Merge conflict');
        expect(gitLines()).toContain(`checkout ${BRANCH}`);
        expect(gitLines()).not.toContain('commit --no-edit');
        expect(feature.container.get(PushDevStateStore).read(repo)).toBeNull();
        expect(builds()).toBe(0);
    });

    it('leaves a file for the developer when no copy explains the dev side', async (): Promise<void> => {
        world.unmerged = ['services/unowned/x.ts'];
        const r = await build();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('services/unowned/x.ts');
        expect(gitLines().some((l: string): boolean => l.startsWith('checkout --ours'))).toBe(false);
    });
});

describe('③ wp-finish-push-dev — publish only what ② verified', () => {
    it('force-pushes the verified copy, leased against the sha ② saw, and prints the watch hints', async (): Promise<void> => {
        world.copySha = 'abc123';
        await build();
        const r = await finish();
        expect(r.thrown).toBeNull();
        expect(pushes()).toEqual([`push --force-with-lease=refs/heads/${COPY}:abc123 origin ${FEATURE_SHA}:refs/heads/${COPY}`]);
        expect(gitLines()).toContain(`update-ref -d ${KEEP_REF}`);
        expect(verifiedRecord()).toBeNull();
        expect(r.out).toContain(`Published ${COPY}`);
        expect(r.out).toContain(`git merge-base --is-ancestor ${FEATURE_SHA} origin/dev`);
    });

    it('a first publish has nothing to lease against', async (): Promise<void> => {
        await build();
        await finish();
        expect(pushes()).toEqual([`push origin ${FEATURE_SHA}:refs/heads/${COPY}`]);
    });

    it('refuses with nothing verified, naming the stages before it', async (): Promise<void> => {
        const r = await finish();
        expect(r.thrown?.exitCode).toBe(2);
        expect(r.thrown?.message).toContain('has not been verified against dev');
        expect(r.thrown?.message).toContain('pnpm wp-start-push-dev');
        expect(r.thrown?.message).toContain('pnpm wp-build-push-dev');
        expect(pushes()).toEqual([]);
    });

    it('refuses when the branch moved after it was verified', async (): Promise<void> => {
        await build();
        world.headSha = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed';
        const r = await finish();
        expect(r.thrown?.message).toContain('moved after it was verified');
        expect(pushes()).toEqual([]);
    });
});

describe('③ wp-finish-push-dev --remove and --list', () => {
    const remove = (): Promise<Outcome> => finish((o: FinishPushDevOptions): void => { o.remove = true; });

    it('--remove deletes the copy ref, then pushes the dev-remove marker at the fresh origin/main tip', async (): Promise<void> => {
        world.copySha = 'abc123';
        const r = await remove();
        expect(r.thrown).toBeNull();
        expect(indexOf('fetch origin +refs/heads/main:refs/remotes/origin/main')).toBeLessThan(indexOf('push origin --delete'));
        expect(pushes()).toEqual([
            `push origin --delete refs/heads/${COPY}`,
            `push --force origin ${MAIN_TIP}:refs/heads/${MARKER}`,
        ]);
        expect(r.out).toContain(`Pushed the marker \`${MARKER}\``);
    });

    it('a failed marker push says the copy is gone but dev was NOT rebuilt', async (): Promise<void> => {
        world.copySha = 'abc123';
        feature.git.respondToPrefix(['-C', repo, 'push', '--force'], feature.git.fail(1, 'remote: Permission denied'));
        const r = await remove();
        expect(r.thrown?.message).toContain(`but pushing the rebuild marker \`${MARKER}\` FAILED`);
        expect(r.thrown?.message).toContain('remote: Permission denied');
        expect(r.thrown?.message).toContain('pnpm wp-finish-push-dev --remove');
    });

    it('--remove of a copy whose PR already landed on main refuses and removes nothing', async (): Promise<void> => {
        world.copySha = 'abc123';
        world.stillDiffer = ['services/z/other-work-on-main.ts'];
        feature.processes.respondToPrefix('gh', ['pr', 'list', '--head', BRANCH, '--state', 'merged'],
            feature.processes.ok('1934 2026-11-04T12:22:00Z\n'));
        const r = await remove();
        expect(r.thrown?.message).toContain(`\`${COPY}\` is already on origin/main (PR #1934 landed 2026-11-04T12:22:00Z)`);
        expect(pushes()).toEqual([]);
    });

    it('--remove on an unpublished branch says so instead of failing', async (): Promise<void> => {
        const r = await remove();
        expect(r.out).toContain('Nothing to remove');
        expect(pushes()).toEqual([]);
    });

    it('--list shows exactly the live copies', async (): Promise<void> => {
        world.copies = ['dev-include/amy/ONE-9', COPY];
        const r = await finish((o: FinishPushDevOptions): void => { o.list = true; });
        expect(r.out).toContain('2 dev copies');
        expect(r.out).toContain('dev-include/amy/ONE-9');
        expect(r.out).toContain(`\`${MARKER.replace('dean/ONE-2275', '<your-branch>')}\` marker`);
    });
});
