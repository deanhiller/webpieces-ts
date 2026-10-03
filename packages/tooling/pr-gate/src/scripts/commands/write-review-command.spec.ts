import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, vi } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AtomicFile } from '@webpieces/tooling-common';
import { ChecklistDefinition, ChecklistInstructionsService, DEFAULT_MAX_CONCURRENT_BUILDS, DiffScope, HomeConfig, HomeConfigService, REVIEWER_AGENTS_PLACEHOLDER, RepoRootFinder, ReviewJsonService, ReviewerAgentPolicy, toChecklist } from '@webpieces/rules-config';
import { ReviewIdentityStamp, ReviewIdentityStampService } from '@webpieces/repo-workflow-core';
import { ReviewBudgetCheckOptions, WriteReviewCommand, WriteReviewOptions } from './write-review-command';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { ChecklistScopeHasher } from '../workflow/checklist-scope-hasher';
import { DiffBasisResolver } from '../workflow/diff-basis';
import { DiffMaterializer } from '../workflow/diff-materializer';
import { ForkPoint } from '../workflow/git-findForkPoint';
import { GitStatusParser } from '../workflow/git-status';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewerIdentityResolver } from '../workflow/reviewer-identity';
import { ReviewerVerdictGate } from '../workflow/reviewer-verdict-gate';
import { HARNESS_TERMINAL, STANDING_CURRENT, VerdictProvenanceService } from '../workflow/verdict-provenance';
import { ReviewRoundStateService } from '../workflow/review-round-state';

/** The branch is fixed rather than read from the process cwd, which a spec does not own. */
class FixedBranchName extends AiBranchName {
    getFeatureName(): string {
        return 'dean-feat';
    }
}

const reviewJson = new ReviewJsonService();
const stamps = new ReviewIdentityStampService();
const provenance = new VerdictProvenanceService(reviewJson, new AtomicFile());
const receipts = new ReviewStageReceiptService(reviewJson);
const rounds = new ReviewRoundStateService(reviewJson, provenance, new AtomicFile());
const RED = JSON.stringify({ id: 'security', status: 'red', agent: 'codex', model: 'gpt-5-codex', output: 'GRANT ALL is too wide' });
const ORANGE = JSON.stringify({ id: 'security', status: 'orange', agent: 'codex', model: 'gpt-5-codex', output: 'narrow GRANT ALL to SELECT' });
const CHECKLISTS: ChecklistDefinition[] = [
    toChecklist({ id: 'security', patterns: ['**/*.sql'], required: true }, new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER)),
];
const GREEN = JSON.stringify({ id: 'security', status: 'green', agent: 'codex', model: 'gpt-5-codex', output: 'no auth surface touched' });

function git(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' });
}

function scanner(): ChecklistScanner {
    const diffScope = new DiffScope();
    const home = new HomeConfigService();
    vi.spyOn(home, 'load').mockReturnValue(new HomeConfig(false, false, DEFAULT_MAX_CONCURRENT_BUILDS, false));
    return new ChecklistScanner(
        new FixedBranchName(new BranchNaming()), new ChecklistDetector(diffScope), diffScope,
        new DiffBasisResolver(new ForkPoint(null as never, null as never, null as never), new GitStatusParser()),
        new PrContextWriter(diffScope, reviewJson), reviewJson, home,
        new ChecklistScopeHasher(new DiffMaterializer(reviewJson)), provenance, receipts, rounds,
    );
}

/** A repo on a feature branch with one in-scope change, and stage ② having briefed `security` on it. */
function briefedRepo(maxRounds = 2): string {
    const dir = specTempDirs.make('wp-write-review-');
    git(dir, 'git init -q -b main');
    git(dir, 'git config user.email t@t.co');
    git(dir, 'git config user.name T');
    fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
    git(dir, 'git add -A');
    git(dir, 'git commit -qm base');
    git(dir, 'git checkout -q -b dean/feat');
    fs.writeFileSync(path.join(dir, 'grant.sql'), 'GRANT ALL;\n');
    git(dir, 'git add -A');
    git(dir, 'git commit -qm change');
    const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(1, false, ''));
    const receipt = new ReviewStageReceipt(scan.basis.headSha, true, 'pnpm build', '', ['security']);
    receipt.scopeHashes = scan.scopeHashes;
    receipt.round = 1;
    receipt.maxReviewerRounds = maxRounds;
    receipts.write(dir, 'dean-feat', receipt);
    return dir;
}

function command(): WriteReviewCommand {
    return new WriteReviewCommand(
        new RepoRootFinder(), new FixedBranchName(new BranchNaming()), receipts,
        new ReviewerIdentityResolver(stamps), provenance, reviewJson);
}

// What the PreToolUse hook writes for the Bash call that runs the bin.
function hookStamp(dir: string, aiType: string, agentId: string): void {
    stamps.write(dir, new ReviewIdentityStamp('security', aiType, 'sess-1', agentId, 'default', dir, new Date().toISOString()));
}

describe('wp-write-review — the one way a reviewer submits a verdict (issue #863)', () => {
    it('lets a CODEX SUBAGENT submit, and records who it was, where, and which scope', async () => {
        const dir = briefedRepo();
        hookStamp(dir, 'codex', 'agent-9');
        await command().run(new WriteReviewOptions('security', GREEN, dir));

        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        const record = provenance.read(summaryPath, 'security', 1);
        expect(record?.harness).toBe('codex');
        expect(record?.agentId).toBe('agent-9');
        expect(record?.scopeHash).toBe(receipts.read(dir, 'dean-feat')?.scopeHashes['security']);
        // …and the gate's own scan counts it: a carried-forward, current verdict.
        const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(1, true, ''));
        expect(scan.standings[0].standing).toBe(STANDING_CURRENT);
        expect(scan.outstanding).toEqual([]);
    });

    it('REFUSES the coordinating agent, and writes nothing', () => {
        const dir = briefedRepo();
        hookStamp(dir, 'codex', '');
        expect(() => command().run(new WriteReviewOptions('security', GREEN, dir))).toThrow(/COORDINATING agent/);
        expect(fs.existsSync(reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1))).toBe(false);
    });

    it('refuses a checklist stage ② did not brief — a carried verdict cannot be overwritten', () => {
        const dir = briefedRepo();
        stamps.write(dir, new ReviewIdentityStamp('other', 'codex', 'sess-1', 'agent-9', 'default', dir, new Date().toISOString()));
        expect(() => command().run(new WriteReviewOptions('other', GREEN.replace('security', 'other'), dir))).toThrow(/was not briefed/);
    });

    it('refuses a verdict with a field outside the schema, naming it', () => {
        const dir = briefedRepo();
        hookStamp(dir, 'claude-code', 'agent-3');
        const withOverride = JSON.stringify({ id: 'security', status: 'red', agent: 'claude', model: 'opus', output: 'x', override: 'ok' });
        expect(() => command().run(new WriteReviewOptions('security', withOverride, dir))).toThrow(/"override" is not a verdict field/);
    });
});

describe('ReviewerIdentityResolver — who is calling', () => {
    it('is a HUMAN at a terminal when there is no harness env and no stamp', () => {
        const dir = briefedRepo();
        expect(new ReviewerIdentityResolver(stamps).resolve(dir, 'security', {}).harness).toBe(HARNESS_TERMINAL);
    });

    it('refuses a harness-launched call the hook did not stamp — it cannot say who is calling', () => {
        const dir = briefedRepo();
        expect(() => new ReviewerIdentityResolver(stamps).resolve(dir, 'security', { CODEX_THREAD_ID: 't-1' }))
            .toThrow(/no usable identity stamp/);
    });
});

describe('wp-finish-upsert-pr rejects a hand-written verdict (issue #863)', () => {
    it('refuses the PR, names the file as NOT COUNTED, and says who may submit one', () => {
        const dir = briefedRepo();
        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        // Exactly what the Codex coordinator did on #1093 and #1095: the right shape, at the right path.
        fs.writeFileSync(reviewJson.checklistResultPath(summaryPath, 'security', 1), GREEN);
        const scan = scanner().scan(dir, CHECKLISTS, new ChecklistScanOptions(1, true, ''));
        const gate = new ReviewerVerdictGate(reviewJson, new ChecklistInstructionsService(reviewJson));
        expect(() => gate.assertEveryReviewerRan(scan)).toThrow(/NOT COUNTED/);
        expect(() => gate.assertEveryReviewerRan(scan)).toThrow(/not submitted through pnpm wp-write-review/);
    });
});

/**
 * Issues #1051 and #1053: the round cap is held by the REVIEWER'S own path, not only by the planner — an
 * author agent spawned a reviewer after the cap was spent, and nothing refused it. Every round's verdict is
 * its own file, and none is ever overwritten.
 */
describe('wp-write-review holds the reviewer-round budget (issues #1051, #1053)', () => {
    const YELLOW = GREEN.replace('"green"', '"yellow"');

    function quietly(fn: () => Promise<void>): Promise<void> {
        const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
        return fn().finally((): void => out.mockRestore());
    }

    function atRound(dir: string, round: number): void {
        const receipt = receipts.read(dir, 'dean-feat') as ReviewStageReceipt;
        receipt.round = round;
        receipts.write(dir, 'dean-feat', receipt);
    }

    it('an IN-cap run proceeds: --check says so (and that it is the FINAL round), and the verdict is recorded', async () => {
        const dir = briefedRepo(1);
        const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
        await command().check(new ReviewBudgetCheckOptions('security', dir));
        expect(String(out.mock.calls[0]?.[0])).toContain('may be reviewed: this is review round 1 of at most 1');
        expect(String(out.mock.calls[0]?.[0])).toContain('FINAL round');
        out.mockRestore();
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', GREEN, dir)));
        expect(fs.existsSync(reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1))).toBe(true);
    });

    it('a second verdict for the same round is refused — by --check and by the submission — and overwrites nothing', async () => {
        const dir = briefedRepo(1);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', GREEN, dir)));
        const verdictPath = reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1);
        const before = fs.readFileSync(verdictPath, 'utf8');

        const refusal = 'I am not allowed to review security: it already has a verdict for review round 1';
        expect(() => command().check(new ReviewBudgetCheckOptions('security', dir))).toThrow(refusal);
        hookStamp(dir, 'claude-code', 'agent-2');
        expect(() => command().run(new WriteReviewOptions('security', YELLOW, dir))).toThrow(refusal);
        expect(() => command().check(new ReviewBudgetCheckOptions('security', dir))).toThrow(/report this refusal, verbatim/);
        expect(() => command().check(new ReviewBudgetCheckOptions('security', dir))).not.toThrow(/end (your|the) turn/i);
        expect(fs.readFileSync(verdictPath, 'utf8')).toBe(before);
    });

    it('refuses a round above maxReviewerRounds and records nothing', () => {
        const dir = briefedRepo(1);
        atRound(dir, 2);
        hookStamp(dir, 'claude-code', 'agent-1');
        expect(() => command().run(new WriteReviewOptions('security', GREEN, dir)))
            .toThrow('this briefing is for review round 2, above maxReviewerRounds (1)');
        expect(reviewJson.latestVerdictRound(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security')).toBe(0);
    });

    it('round 2 of 2 records a NEW file beside round 1 — every round is kept', async () => {
        const dir = briefedRepo(2);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', RED, dir)));
        atRound(dir, 2);
        hookStamp(dir, 'claude-code', 'agent-2');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', YELLOW, dir)));
        const summaryPath = reviewJson.summaryJsonPath(dir, 'dean-feat');
        expect(JSON.parse(fs.readFileSync(reviewJson.checklistResultPath(summaryPath, 'security', 1), 'utf8')).status).toBe('red');
        expect(JSON.parse(fs.readFileSync(reviewJson.checklistResultPath(summaryPath, 'security', 2), 'utf8')).status).toBe('yellow');
        expect(provenance.read(summaryPath, 'security', 2)?.round).toBe(2);
        expect(rounds.highestRound(summaryPath)).toBe(2);
    });
});

/** Issue #1053, section 1: the LAST allowed round has no red — it has orange. */
describe('wp-write-review fits the color to the round (issue #1053)', () => {
    function quietly(fn: () => Promise<void>): Promise<void> {
        const out = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
        return fn().finally((): void => out.mockRestore());
    }

    it('with maxReviewerRounds: 1, refuses RED and names ORANGE — and records nothing', () => {
        const dir = briefedRepo(1);
        hookStamp(dir, 'claude-code', 'agent-1');
        expect(() => command().run(new WriteReviewOptions('security', RED, dir))).toThrow(/"status": "red" is not allowed: review round 1 of 1 is the FINAL round/);
        hookStamp(dir, 'claude-code', 'agent-1');
        expect(() => command().run(new WriteReviewOptions('security', RED, dir))).toThrow(/Mark anything that must be fixed "orange"/);
        expect(reviewJson.latestVerdictRound(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security')).toBe(0);
    });

    it('with maxReviewerRounds: 1, accepts ORANGE', async () => {
        const dir = briefedRepo(1);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', ORANGE, dir)));
        const verdictPath = reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1);
        expect(JSON.parse(fs.readFileSync(verdictPath, 'utf8')).status).toBe('orange');
    });

    it('before the final round, refuses ORANGE and names RED — a re-review is still paid for', async () => {
        const dir = briefedRepo(2);
        hookStamp(dir, 'claude-code', 'agent-1');
        expect(() => command().run(new WriteReviewOptions('security', ORANGE, dir))).toThrow(/"status": "orange" is only for the FINAL review round/);
        hookStamp(dir, 'claude-code', 'agent-1');
        await quietly((): Promise<void> => command().run(new WriteReviewOptions('security', RED, dir)));
        const verdictPath = reviewJson.checklistResultPath(reviewJson.summaryJsonPath(dir, 'dean-feat'), 'security', 1);
        expect(JSON.parse(fs.readFileSync(verdictPath, 'utf8')).status).toBe('red');
    });
});

// Cross-package integration: the hook producer and the CLI writer must select the SAME namespace.
describe('linked-worktree hook-to-writer routing (#1105)', () => {
    function worktrees(): string[] {
        const primary = briefedRepo();
        const parent = specTempDirs.makeReal('wp-stamp-trees-');
        const first = path.join(parent, 'first');
        const second = path.join(parent, 'second');
        git(primary, `git worktree add -q -b review-first "${first}"`);
        git(primary, `git worktree add -q -b review-second "${second}"`);
        for (const tree of [first, second]) {
            receipts.write(tree, 'dean-feat', receipts.read(primary, 'dean-feat')!);
        }
        return [primary, first, second];
    }

    function submitHook(primary: string, target: string, agentId = 'reviewer-1105'): void {
        const bash = `cd '${target}' && pnpm wp-write-review --checklist security`;
        // Run the hook producer in a separate process, as in production. A static test import here
        // would falsely add agent-workflow-rules to pr-gate's package dependency graph.
        const producer = path.resolve(__dirname, '../../../../agent-workflow-rules/src/adapters/review-identity-stamper.ts');
        const payload = JSON.stringify({
            tool_name: 'Bash', tool_input: { command: bash }, cwd: primary,
            turn_id: 'fixture-turn', session_id: 'fixture-session', agent_id: agentId, agent_type: 'default',
        });
        const hookScript = `
            const { ReviewIdentityStamper } = require(${JSON.stringify(producer)});
            const { CodexAdapter } = require('@webpieces/hook-runtime');
            const payload = JSON.parse(process.argv[1]);
            const event = new CodexAdapter().toEvent(payload, payload.cwd);
            new ReviewIdentityStamper().stamp(event, payload.tool_input.command, payload.cwd);
        `;
        execFileSync(process.execPath, ['-r', '@swc-node/register', '-r', 'tsconfig-paths/register', '-e', hookScript, payload], {
            env: { ...process.env, TS_NODE_PROJECT: path.resolve(__dirname, '../../../../../../tsconfig.base.json') },
            stdio: 'pipe',
        });
    }

    it('writes a legitimate verdict in the target worktree and consumes the hook stamp once', async () => {
        const [primary, target, other] = worktrees();
        submitHook(primary, target);
        expect(fs.existsSync(stamps.stampPath(primary, 'security'))).toBe(false);
        expect(stamps.take(other, 'security')).toBeNull();
        expect(stamps.take(target, 'other-checklist')).toBeNull();
        const stampPath = stamps.stampPath(target, 'security');
        expect(stampPath).toContain(
            `/.webpieces/worktrees/${path.basename(target)}/review-stamps/`,
        );
        const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
        expect(stamp.cwd).toBe(target);
        expect(stamp.sessionId).toBe('fixture-session');
        await command().run(new WriteReviewOptions('security', GREEN, target));
        const record = provenance.read(
            reviewJson.summaryJsonPath(target, 'dean-feat'),
            'security',
            1,
        );
        expect(record?.agentId).toBe('reviewer-1105');
        expect(record?.harness).toBe('codex');
        expect(stamps.take(target, 'security')).toBeNull();
        expect(
            provenance.read(reviewJson.summaryJsonPath(other, 'dean-feat'), 'security', 1),
        ).toBeNull();
    });

    it('still refuses a coordinator routed into a worktree', () => {
        const [primary, target] = worktrees();
        submitHook(primary, target, '');
        expect(() => command().run(new WriteReviewOptions('security', GREEN, target))).toThrow(
            /COORDINATING agent/,
        );
        expect(stamps.take(target, 'security')).toBeNull();
    });

    it('reports the expected namespace when an old hook stamped the session tree', () => {
        const [primary, target] = worktrees();
        hookStamp(primary, 'codex', 'reviewer-1105');
        const resolve = (): void => {
            new ReviewerIdentityResolver(stamps).resolve(target, 'security', {
                CODEX_THREAD_ID: 'fixture-session',
            });
        };
        expect(resolve).toThrow(stamps.stampPath(target, 'security'));
        expect(resolve).toThrow('Submission cwd: ' + target);
        expect(resolve).toThrow('leading cd');
        expect(resolve).not.toThrow('hooks are not installed');
        expect(stamps.take(primary, 'security')?.agentId).toBe('reviewer-1105');
    });
});
