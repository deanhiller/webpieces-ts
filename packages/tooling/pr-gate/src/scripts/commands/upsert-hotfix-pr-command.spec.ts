import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BranchIdentity } from '@webpieces/repo-workflow-core';
import { CliExitError, GateTokenService, HOTFIX_BUILD_COMMAND, PrGateConfig, RepoRootFinder, ReviewJsonService } from '@webpieces/rules-config';
import { GitResultDto, InformAiError, ProcessResultDto } from '@webpieces/tooling-common';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { GitExec } from '../workflow/git-exec';
import { BuildAffected } from '../workflow/build-affected';
import { BuildArtifactGate } from '../workflow/build-artifact-gate';
import { MergeState } from '../workflow/merge-state';
import { ChecklistScanner } from '../workflow/checklist-scanner';
import { HotfixPrPublisher } from '../workflow/hotfix-pr-publisher';
import { PrCommentUpserter } from '../workflow/pr-comment-upserter';
import { SquashSettingsEnforcer } from '../workflow/squash-settings-enforcer';
import { Dashboard } from '../../dashboard/dashboard';
import { ChecklistCommentRenderer } from '../../dashboard/checklist-comment-renderer';
import { AuthorIdentityResolver } from '../../dashboard/author-identity';
import { UpsertHotfixPrCommand } from './upsert-hotfix-pr-command';

/**
 * `wp-upsert-hotfix-pr` with git and `gh` SCRIPTED (#1381). The publisher, the gh comment upsert, the
 * squash-settings check and the dashboard are the production objects from the shipped container; the
 * build gate, the merge-state read and the config are the only collaborators stood in for, because each
 * reads a whole repository's configuration rather than an outside system.
 *
 * What #1057 cares about is what the command asks git to DO: a fast-forward `push -u` of HEAD and
 * nothing else — never a merge of main, never a rewrite, never a force. So that is what is asserted, on
 * the exact commands issued, in the order they reached the outside world.
 */

const HOTFIX_BRANCH = 'dean/hotfix/fix-timeout';
const FEATURE = 'dean-hotfix-fix-timeout';
const SALT = 'spec-salt';
const PROD_SHA = 'a'.repeat(40);
const MAIN_SHA = 'c'.repeat(40);
const FIX_SHA = 'f'.repeat(40);
const PR_URL = 'https://github.test/o/r/pull/77';

function asType<T>(value: object): T {
    return value as unknown as T;
}

class TestCommand extends UpsertHotfixPrCommand {
    protected override prGateConfig(): PrGateConfig {
        return asType<PrGateConfig>({ gates: [], gateSalt: SALT, checklists: [], checklistComments: false, maxReviewerRounds: 2 });
    }
}

/** What the outside world holds and answers, and everything that reached it, in order. */
class World {
    head = FIX_SHA;
    porcelain = '';
    openPr = '';
    pushRejected = false;
    order: string[] = [];
    bodies: string[] = [];
}

class Fixture {
    repo = '';
    branch = HOTFIX_BRANCH;
    builds = 0;
    redBuild = false;
    // Somebody commits while hotfix-ci runs.
    moveHeadDuringBuild = false;
    world = new World();
    feature!: PrGateFeature;

    async setUp(): Promise<void> {
        this.repo = specTempDirs.makeReal('wp-upsert-hotfix-');
        this.feature = await PrGateFeature.create();
        this.scriptGit();
        this.scriptGitHub();
    }

    private scriptGit(): void {
        const git = this.feature.git;
        const w = this.world;
        git.respond(['status', '--porcelain'], (): GitResultDto => git.ok(w.porcelain));
        git.respond(['fetch', 'origin', 'main'], git.ok());
        git.respond(['rev-parse', 'HEAD'], (): GitResultDto => git.ok(`${w.head}\n`));
        git.respond(['rev-parse', 'origin/main'], git.ok(`${MAIN_SHA}\n`));
        git.respond(['merge-base', 'origin/main', 'HEAD'], git.ok(`${PROD_SHA}\n`));
        git.respondToPrefix(['diff'], (call): GitResultDto =>
            git.ok(call.args.includes('--name-only') ? 'app.txt\n' : '--- a/app.txt\n+++ b/app.txt\n-v1\n+v1 + fix\n'));
        git.respondToPrefix(['push'], (call): GitResultDto => {
            w.order.push(`git ${call.args.join(' ')}`);
            return w.pushRejected
                ? git.fail(1, ` ! [rejected]        HEAD -> ${HOTFIX_BRANCH} (fetch first)`)
                : git.ok();
        });
    }

    private scriptGitHub(): void {
        const gh = this.feature.processes;
        const w = this.world;
        gh.respondToPrefix('gh', ['pr', 'list', '--head', HOTFIX_BRANCH], (): ProcessResultDto => gh.ok(w.openPr === '' ? '' : `${w.openPr}\n`));
        gh.respondToPrefix('gh', ['pr', 'view', HOTFIX_BRANCH], (): ProcessResultDto =>
            w.openPr === '' ? gh.fail(1, 'no pull requests found') : gh.ok(`${w.openPr}\t${PR_URL}\n`));
        gh.respondToPrefix('gh', ['pr', 'create'], (call): ProcessResultDto => {
            w.order.push(`gh pr create --head ${call.args[call.args.indexOf('--head') + 1]}`);
            w.bodies.push(this.bodyOf(call.args));
            w.openPr = '77';
            return gh.ok();
        });
        gh.respondToPrefix('gh', ['pr', 'edit'], (call): ProcessResultDto => {
            const hasTitle = call.args.includes('--title');
            w.order.push(`gh pr edit #${call.args[2]}${hasTitle ? '' : ' (body back-fill)'}`);
            w.bodies.push(this.bodyOf(call.args));
            return gh.ok();
        });
        // The comment upsert (find, then POST/PATCH) and the squash-settings read — both production code.
        gh.respondToPrefix('gh', ['api', '--paginate'], gh.ok(''));
        gh.respondToPrefix('gh', ['api', '--method'], (call): ProcessResultDto => {
            w.order.push(`gh comment ${call.args[2]}`);
            return gh.ok();
        });
        gh.respondToPrefix('gh', ['api', 'repos/{owner}/{repo}', '--jq'], gh.ok('PR_TITLE\tPR_BODY\ttrue\n'));
    }

    private bodyOf(args: readonly string[]): string {
        return fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
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
            summary: 'Raises the checkout timeout in production.',
            addressesIssues: [{ url: 'https://github.com/deanhiller/webpieces-ts/issues/1057', closesIssue: true }],
            violations: [],
            risks: [],
            filesToReview: [],
        }));
        return file;
    }

    /** Every command that WROTE to the outside world: pushes, PR edits/creates, comments. */
    writes(): string[] {
        return this.world.order;
    }

    gitCommands(): string[] {
        return this.feature.git.commandLines();
    }

    command(): TestCommand {
        const c = this.feature.container;
        const fixture = this;
        return new TestCommand(
            asType<RepoRootFinder>({ resolveRepoRoot: (): string => fixture.repo }),
            asType<BranchIdentity>({
                current: (): string => fixture.branch,
                isHotfix: (name: string): boolean => new BranchIdentity().isHotfix(name),
            }),
            asType<AiBranchName>({ getFeatureName: async (): Promise<string> => FEATURE }),
            c.get(GitExec),
            new ReviewJsonService(),
            asType<BuildAffected>({
                runBuildGate: async (): Promise<void> => {
                    fixture.builds += 1;
                    if (fixture.moveHeadDuringBuild) fixture.world.head = 'e'.repeat(40);
                    if (fixture.redBuild) throw new CliExitError(1, 'hotfix-ci failed');
                },
                resolveBuildCommand: (): string => HOTFIX_BUILD_COMMAND,
            }),
            asType<BuildArtifactGate>({ assertBuildLeftNothingUncommitted: async (): Promise<void> => undefined }),
            asType<MergeState>({ mergeDirFor: (): string => '/none', findActiveMergeRunDir: (): null => null }),
            asType<ChecklistScanner>({}),
            c.get(HotfixPrPublisher),
            c.get(Dashboard),
            c.get(AuthorIdentityResolver),
            c.get(ChecklistCommentRenderer),
            c.get(PrCommentUpserter),
            c.get(SquashSettingsEnforcer),
            new GateTokenService(),
            this.feature.processes,
        );
    }
}

let fx = new Fixture();
let output: CapturedOutput;

beforeEach(async () => {
    fx = new Fixture();
    await fx.setUp();
    output = CapturedOutput.start();
});

afterEach(() => {
    output.stop();
    fs.rmSync(fx.repo, { recursive: true, force: true });
});

describe('wp-upsert-hotfix-pr (issue #1057)', () => {
    it('refuses a branch without the exact /hotfix/ segment, before building or pushing anything', async () => {
        fx.branch = 'dean/hotfix-fix-timeout';
        fx.writeSummary();
        await expect(fx.command().run()).rejects.toThrowError(/only runs on a branch containing the exact, case-sensitive \/hotfix\/ segment/);
        expect(fx.builds).toBe(0);
        expect(fx.writes()).toEqual([]);
        expect(fx.feature.git.calls).toEqual([]);
    });

    it('exits with the summary path and schema when summary.json is missing, before building or pushing', async () => {
        const expectedPath = new ReviewJsonService().summaryJsonPath(fx.repo, FEATURE);
        await expect(fx.command().run()).rejects.toBeInstanceOf(InformAiError);
        await expect(fx.command().run()).rejects.toThrowError(expectedPath);
        await expect(fx.command().run()).rejects.toThrowError(/Then re-run: pnpm wp-upsert-hotfix-pr/);
        expect(fx.builds).toBe(0);
        expect(fx.writes()).toEqual([]);
    });

    it('requires a clean tree', async () => {
        fx.writeSummary();
        fx.world.porcelain = '?? stray.txt\n';
        await expect(fx.command().run()).rejects.toThrowError(/uncommitted or untracked changes/);
        expect(fx.builds).toBe(0);
        expect(fx.writes()).toEqual([]);
    });

    it('a red hotfix-ci gate means nothing is pushed and no PR is touched', async () => {
        fx.writeSummary();
        fx.redBuild = true;
        await expect(fx.command().run()).rejects.toThrowError(/hotfix-ci failed/);
        expect(fx.builds).toBe(1);
        expect(fx.writes()).toEqual([]);
    });

    it('refuses to push when HEAD moved while the build ran — the build would not cover the pushed commit', async () => {
        fx.writeSummary();
        fx.moveHeadDuringBuild = true;

        await expect(fx.command().run()).rejects.toThrowError(/HEAD moved while the hotfix build ran/);
        expect(fx.writes()).toEqual([]);
    });

    it('pushes prod + fix only — no merge from main, no rewrite — and opens the bannered PR without merging it', async () => {
        fx.writeSummary();

        await fx.command().run();

        // The only write to the remote is ONE fast-forward push of HEAD: nothing merges main in, nothing
        // squashes, rebases, resets or forces.
        expect(fx.writes()).toEqual([
            `git push -u origin HEAD:${HOTFIX_BRANCH}`,
            `gh pr create --head ${HOTFIX_BRANCH}`,
            'gh pr edit #77 (body back-fill)',
            'gh comment POST',
        ]);
        expect(fx.gitCommands().filter((l: string): boolean => /\b(merge|rebase|reset|commit|checkout)\b/.test(l)
            && !l.includes('merge-base'))).toEqual([]);
        expect(fx.gitCommands().some((l: string): boolean => l.includes('--force'))).toBe(false);
        // origin/main is READ for the fork point — fetched, never merged.
        expect(fx.gitCommands()).toContain('git fetch origin main');
        expect(fx.feature.processes.callsStartingWith('gh', ['pr', 'merge'])).toEqual([]);

        expect(fx.builds).toBe(1);
        const body = fx.world.bodies[fx.world.bodies.length - 1];
        expect(body.startsWith('# ⚠️ HOT FIX ⚠️')).toBe(true);
        expect(body).toContain(PR_URL);
        expect(body).toContain('Generated by webpieces-ts wp-upsert-hotfix-pr');
        // summary.json's addressesIssues reaches the hotfix body exactly as finish renders it (issue #1310).
        expect(body).toContain('\nFixes https://github.com/deanhiller/webpieces-ts/issues/1057\n');
        expect(new GateTokenService().verifyGateToken(body, SALT, FIX_SHA)).toBe(true);
        // The full-dashboard comment is the 1st comment, and it carries the audit banner first.
        const comment = fx.feature.processes.callsStartingWith('gh', ['api', '--method'])[0];
        const payload = JSON.parse(fs.readFileSync(comment.args[comment.args.indexOf('--input') + 1], 'utf8'));
        expect(payload.body.startsWith('# ⚠️ HOT FIX ⚠️')).toBe(true);

        const printed = output.stdout;
        expect(printed).toContain('auto-merge was NOT enabled');
        expect(printed).toContain('⚠ Merging this PR will CLOSE https://github.com/deanhiller/webpieces-ts/issues/1057 (closesIssue: true)');
        expect(printed).not.toMatch(/\bend(?:ing|s)? (?:your|the|its) turn\b/i);
        // summary.json was consumed, so the next run demands a fresh one.
        expect(fs.existsSync(new ReviewJsonService().summaryJsonPath(fx.repo, FEATURE))).toBe(false);
    });

    it('a re-run after another commit pushes again and updates the SAME PR', async () => {
        fx.writeSummary();
        await fx.command().run();
        const second = 'd'.repeat(40);
        fx.world.head = second;
        fx.writeSummary();
        fx.world.order = [];

        await fx.command().run();

        // Body FIRST, then the push — and the existing PR is edited, never a second one created.
        expect(fx.writes()).toEqual(['gh pr edit #77', `git push -u origin HEAD:${HOTFIX_BRANCH}`, 'gh comment POST']);
        expect(new GateTokenService().verifyGateToken(fx.world.bodies[fx.world.bodies.length - 1], SALT, second)).toBe(true);
    });

    it('never force-pushes: a remote branch that diverged is refused, not overwritten', async () => {
        fx.writeSummary();
        fx.world.openPr = '77';
        fx.world.pushRejected = true;

        await expect(fx.command().run()).rejects.toThrowError(/fast-forward only/);
        // One plain push was attempted and refused; nothing retried it with force.
        expect(fx.feature.git.callsStartingWith(['push']).map((c): string => c.commandLine))
            .toEqual([`git push -u origin HEAD:${HOTFIX_BRANCH}`]);
    });
});
