import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BranchIdentity,
    CliExitError,
    GateTokenService,
    HOTFIX_BUILD_COMMAND,
    InformAiError,
    PrGateConfig,
    RepoRootFinder,
    ReviewJsonService,
    specTempDirs,
} from '@webpieces/rules-config';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { GitExec } from '../workflow/git-exec';
import { GitStatusParser } from '../workflow/git-status';
import { BuildAffected } from '../workflow/build-affected';
import { BuildArtifactGate } from '../workflow/build-artifact-gate';
import { MergeState } from '../workflow/merge-state';
import { ChecklistScanner } from '../workflow/checklist-scanner';
import { HotfixPrPublisher } from '../workflow/hotfix-pr-publisher';
import { PrCommentRequest, PrCommentResult, PrCommentUpserter } from '../workflow/pr-comment-upserter';
import { SquashSettingsEnforcer } from '../workflow/squash-settings-enforcer';
import { Dashboard } from '../../dashboard/dashboard';
import { ChecklistCommentRenderer } from '../../dashboard/checklist-comment-renderer';
import { AuthorIdentityResolver } from '../../dashboard/author-identity';
import { HotfixPrRef, UpsertHotfixPrCommand } from './upsert-hotfix-pr-command';

const HOTFIX_BRANCH = 'dean/hotfix/fix-timeout';
const FEATURE = 'dean-hotfix-fix-timeout';
const SALT = 'spec-salt';

function asType<T>(value: object): T {
    return value as unknown as T;
}

/** The GitHub side, faked: which PR is open for which head branch, and every gh write that happened. */
class FakeGitHub {
    prs = new Map<string, HotfixPrRef>();
    calls: string[] = [];
    bodies: string[] = [];
}

/** The REAL fast-forward push into the spec's bare origin; only the gh seams are faked. */
class FakeHotfixPublisher extends HotfixPrPublisher {
    constructor(gitExec: GitExec, private readonly gh: FakeGitHub, private readonly repo: string) {
        super(gitExec);
    }

    protected override findOpenPr(baseBranch: string): string {
        return this.gh.prs.get(baseBranch)?.number ?? '';
    }

    protected override editPr(prNumber: string, title: string, bodyFile: string): boolean {
        this.gh.calls.push(`edit #${prNumber}`);
        this.gh.bodies.push(fs.readFileSync(bodyFile, 'utf8'));
        return true;
    }

    protected override createPr(baseBranch: string, title: string, bodyFile: string): boolean {
        this.gh.calls.push(`create ${baseBranch}`);
        this.gh.bodies.push(fs.readFileSync(bodyFile, 'utf8'));
        this.gh.prs.set(baseBranch, new HotfixPrRef('77', 'https://github.test/o/r/pull/77'));
        return true;
    }

    protected override push(baseBranch: string): void {
        this.gh.calls.push(`push ${baseBranch}`);
        this.pushFastForward(this.repo, baseBranch);
    }
}

class TestCommand extends UpsertHotfixPrCommand {
    constructor(private readonly gh: FakeGitHub, deps: ConstructorParameters<typeof UpsertHotfixPrCommand>) {
        super(...deps);
    }

    protected override prGateConfig(): PrGateConfig {
        return asType<PrGateConfig>({ gates: [], gateSalt: SALT, checklists: [], checklistComments: false, maxReviewerRounds: 2 });
    }

    protected override prRef(branch: string): HotfixPrRef {
        return this.gh.prs.get(branch) ?? new HotfixPrRef('', '');
    }

    protected override editPrBody(prNumber: string, bodyFile: string): boolean {
        this.gh.calls.push(`backfill #${prNumber}`);
        this.gh.bodies.push(fs.readFileSync(bodyFile, 'utf8'));
        return true;
    }
}

class Fixture {
    root = '';
    repo = '';
    prodSha = '';
    branch = HOTFIX_BRANCH;
    builds = 0;
    redBuild = false;
    gh = new FakeGitHub();
    comments: PrCommentRequest[] = [];

    git(args: string[], cwd: string = this.repo): string {
        return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    }

    commit(file: string, content: string, message: string): string {
        fs.writeFileSync(path.join(this.repo, file), content);
        this.git(['add', file]);
        this.git(['commit', '-qm', message]);
        return this.git(['rev-parse', 'HEAD']);
    }

    /**
     * origin/main = prod → unpromoted; the hotfix branch is cut from PROD (an old sha), not from main.
     * That is the shape issue #1057 is about: merging main in would ship `unpromoted`.
     */
    setUp(): void {
        this.root = specTempDirs.makeReal('wp-upsert-hotfix-');
        this.repo = path.join(this.root, 'repo');
        const origin = path.join(this.root, 'origin.git');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
        fs.mkdirSync(this.repo);
        this.git(['init', '-q', '-b', 'main']);
        this.git(['config', 'core.hooksPath', '/dev/null']);
        this.git(['config', 'user.email', 'spec@example.com']);
        this.git(['config', 'user.name', 'spec']);
        fs.writeFileSync(path.join(this.repo, '.gitignore'), '.webpieces/\n');
        this.git(['add', '.gitignore']);
        this.prodSha = this.commit('app.txt', 'v1\n', 'prod');
        this.git(['remote', 'add', 'origin', origin]);
        this.git(['push', '-q', 'origin', 'main']);
        this.commit('unpromoted.txt', 'not in prod yet\n', 'unpromoted');
        this.git(['push', '-q', 'origin', 'main']);
        this.git(['checkout', '-q', '-b', HOTFIX_BRANCH, this.prodSha]);
        this.commit('app.txt', 'v1 + fix\n', 'fix');
    }

    writeSummary(): string {
        const file = new ReviewJsonService().summaryJsonPath(this.repo, FEATURE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            title: 'Fix the checkout timeout',
            agent: 'claude-code',
            model: 'spec',
            riskScore: 40,
            riskLevel: 'yellow',
            summary: 'Fixes #1057\n\nRaises the checkout timeout in production.',
            violations: [],
            risks: [],
            filesToReview: [],
        }));
        return file;
    }

    remoteSha(branch: string): string {
        const out = this.git(['ls-remote', '--heads', 'origin', branch]);
        return out === '' ? '' : out.split(/\s+/)[0];
    }

    command(): TestCommand {
        const gitExec = new GitExec(new RepoRootFinder(), new GitStatusParser());
        const fixture = this;
        return new TestCommand(this.gh, [
            asType<RepoRootFinder>({ resolveRepoRoot: (): string => fixture.repo }),
            asType<BranchIdentity>({
                current: (): string => fixture.branch,
                isHotfix: (name: string): boolean => new BranchIdentity().isHotfix(name),
            }),
            asType<AiBranchName>({ getFeatureName: (): string => FEATURE }),
            gitExec,
            new ReviewJsonService(),
            asType<BuildAffected>({
                runBuildGate: async (): Promise<void> => {
                    fixture.builds += 1;
                    if (fixture.redBuild) throw new CliExitError(1, 'hotfix-ci failed');
                },
                resolveBuildCommand: (): string => HOTFIX_BUILD_COMMAND,
            }),
            asType<BuildArtifactGate>({ assertBuildLeftNothingUncommitted: (): void => undefined }),
            asType<MergeState>({ mergeDirFor: (): string => '/none', findActiveMergeRunDir: (): null => null }),
            asType<ChecklistScanner>({}),
            new FakeHotfixPublisher(gitExec, this.gh, this.repo),
            new Dashboard(),
            new AuthorIdentityResolver(),
            new ChecklistCommentRenderer(),
            asType<PrCommentUpserter>({
                upsert: (request: PrCommentRequest): PrCommentResult => {
                    fixture.comments.push(request);
                    return new PrCommentResult('1', false, true);
                },
            }),
            asType<SquashSettingsEnforcer>({ ensure: (): void => undefined }),
            new GateTokenService(),
        ]);
    }
}

let fx = new Fixture();
let stdout: string[] = [];

beforeEach(() => {
    fx = new Fixture();
    fx.setUp();
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
        stdout.push(String(chunk));
        return true;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('wp-upsert-hotfix-pr (issue #1057)', () => {
    it('refuses a branch without the exact /hotfix/ segment, before building or pushing anything', async () => {
        fx.branch = 'dean/hotfix-fix-timeout';
        fx.writeSummary();
        await expect(fx.command().run()).rejects.toThrowError(/only runs on a branch containing the exact, case-sensitive \/hotfix\/ segment/);
        expect(fx.builds).toBe(0);
        expect(fx.gh.calls).toEqual([]);
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe('');
    });

    it('exits with the summary path and schema when summary.json is missing, before building or pushing', async () => {
        const expectedPath = new ReviewJsonService().summaryJsonPath(fx.repo, FEATURE);
        const run = fx.command().run();
        await expect(run).rejects.toBeInstanceOf(InformAiError);
        await expect(fx.command().run()).rejects.toThrowError(expectedPath);
        await expect(fx.command().run()).rejects.toThrowError(/Then re-run: pnpm wp-upsert-hotfix-pr/);
        expect(fx.builds).toBe(0);
        expect(fx.gh.calls).toEqual([]);
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe('');
    });

    it('requires a clean tree', async () => {
        fx.writeSummary();
        fs.writeFileSync(path.join(fx.repo, 'stray.txt'), 'uncommitted\n');
        await expect(fx.command().run()).rejects.toThrowError(/uncommitted or untracked changes/);
        expect(fx.builds).toBe(0);
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe('');
    });

    it('a red hotfix-ci gate means nothing is pushed and no PR is touched', async () => {
        fx.writeSummary();
        fx.redBuild = true;
        await expect(fx.command().run()).rejects.toThrowError(/hotfix-ci failed/);
        expect(fx.builds).toBe(1);
        expect(fx.gh.calls).toEqual([]);
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe('');
    });

    it('pushes prod + fix only — no merge from main, no rewrite — and opens the bannered PR without merging it', async () => {
        fx.writeSummary();
        const headBefore = fx.git(['rev-parse', 'HEAD']);

        await fx.command().run();

        // The branch is exactly what was committed: never merged with main, never squashed or rewritten.
        expect(fx.git(['rev-parse', 'HEAD'])).toBe(headBefore);
        expect(fx.git(['rev-parse', 'HEAD~1'])).toBe(fx.prodSha);
        expect(fx.git(['rev-list', '--merges', `${fx.prodSha}..HEAD`])).toBe('');
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe(headBefore);
        // The PR's three-dot diff against main is the fix alone — `unpromoted.txt` does not ship.
        expect(fx.git(['diff', '--name-only', `origin/main...origin/${HOTFIX_BRANCH}`])).toBe('app.txt');
        expect(fx.git(['log', '--format=%s', `origin/main..origin/${HOTFIX_BRANCH}`])).toBe('fix');

        expect(fx.builds).toBe(1);
        expect(fx.gh.calls).toEqual([`push ${HOTFIX_BRANCH}`, `create ${HOTFIX_BRANCH}`, 'backfill #77']);
        expect(fx.gh.calls.some((call: string): boolean => call.includes('merge'))).toBe(false);
        const body = fx.gh.bodies[fx.gh.bodies.length - 1];
        expect(body.startsWith('# ⚠️ HOT FIX ⚠️')).toBe(true);
        expect(body).toContain('https://github.test/o/r/pull/77');
        expect(body).toContain('Generated by webpieces-ts wp-upsert-hotfix-pr');
        expect(new GateTokenService().verifyGateToken(body, SALT, headBefore)).toBe(true);
        expect(fx.comments.map((c: PrCommentRequest): string => c.label)).toEqual(['full dashboard comment']);
        expect(fx.comments[0].body.startsWith('# ⚠️ HOT FIX ⚠️')).toBe(true);

        const printed = stdout.join('');
        expect(printed).toContain('auto-merge was NOT enabled');
        expect(printed).not.toMatch(/\bend(?:ing|s)? (?:your|the|its) turn\b/i);
        // summary.json was consumed, so the next run demands a fresh one.
        expect(fs.existsSync(new ReviewJsonService().summaryJsonPath(fx.repo, FEATURE))).toBe(false);
    });

    it('a re-run after another commit pushes again and updates the SAME PR', async () => {
        fx.writeSummary();
        await fx.command().run();
        const second = fx.commit('app.txt', 'v1 + fix + follow-up\n', 'follow-up fix');
        fx.writeSummary();
        fx.gh.calls = [];

        await fx.command().run();

        expect(fx.gh.calls).toEqual(['edit #77', `push ${HOTFIX_BRANCH}`]);
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe(second);
        expect(fx.git(['log', '--format=%s', `origin/main..origin/${HOTFIX_BRANCH}`])).toBe('follow-up fix\nfix');
        expect(fx.git(['rev-list', '--merges', `${fx.prodSha}..HEAD`])).toBe('');
        expect(new GateTokenService().verifyGateToken(fx.gh.bodies[fx.gh.bodies.length - 1], SALT, second)).toBe(true);
    });

    it('never force-pushes: a remote branch that diverged is refused, not overwritten', async () => {
        fx.writeSummary();
        await fx.command().run();
        const theirs = path.join(fx.root, 'theirs');
        execFileSync('git', ['clone', '-q', '-b', HOTFIX_BRANCH, path.join(fx.root, 'origin.git'), theirs]);
        execFileSync('git', ['-c', 'user.email=o@example.com', '-c', 'user.name=o', 'commit', '-q', '--allow-empty', '-m', 'theirs'], { cwd: theirs });
        execFileSync('git', ['push', '-q', 'origin', HOTFIX_BRANCH], { cwd: theirs });
        const theirsSha = fx.remoteSha(HOTFIX_BRANCH);
        fx.commit('app.txt', 'mine\n', 'mine');
        fx.writeSummary();

        await expect(fx.command().run()).rejects.toThrowError(/fast-forward only/);
        expect(fx.remoteSha(HOTFIX_BRANCH)).toBe(theirsSha);
    });
});
