import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SubagentProvenanceService, EvidenceRequest, PROVENANCE_OK, PROVENANCE_MISSING, PROVENANCE_SKIPPED,
} from './subagent-provenance';

const svc = new SubagentProvenanceService();
const savedHome = process.env['HOME'];
const savedSession = process.env['CLAUDE_CODE_SESSION_ID'];

afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    if (savedSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']; else process.env['CLAUDE_CODE_SESSION_ID'] = savedSession;
});

// Build a fake ~/.claude/projects/<slug>/<sessionId>/subagents dir with one agent's artifacts.
function fakeHarness(sessionId: string, agentType: string, branch: string, spawnDepth = 1, isSidechain = true): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
    const dir = path.join(home, '.claude', 'projects', '-Some-Slug', sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-abc.meta.json'), JSON.stringify({ agentType, spawnDepth }));
    fs.writeFileSync(path.join(dir, 'agent-abc.jsonl'), JSON.stringify({ isSidechain, gitBranch: branch }) + '\n');
    return home;
}

describe('SubagentProvenanceService', () => {
    it('skips (passes with a warning) when CLAUDE_CODE_SESSION_ID is unset', () => {
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        const res = svc.verify('checklist-reviewer', 'dean/feat');
        expect(res.status).toBe(PROVENANCE_SKIPPED);
    });

    it('verifies OK when a matching subagent ran on this branch', () => {
        process.env['HOME'] = fakeHarness('sess-1', 'checklist-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-1';
        expect(svc.verify('checklist-reviewer', 'dean/feat').status).toBe(PROVENANCE_OK);
    });

    it('tolerates a leftover wpN branch-rename suffix', () => {
        process.env['HOME'] = fakeHarness('sess-2', 'checklist-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-2';
        expect(svc.verify('checklist-reviewer', 'dean/feat-wp3').status).toBe(PROVENANCE_OK);
    });

    it('is MISSING when no subagent of that agentType ran', () => {
        process.env['HOME'] = fakeHarness('sess-3', 'some-other-agent', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-3';
        expect(svc.verify('checklist-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('is MISSING when spawnDepth < 1 (the main loop, not a subagent)', () => {
        process.env['HOME'] = fakeHarness('sess-4', 'checklist-reviewer', 'dean/feat', 0);
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-4';
        expect(svc.verify('checklist-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('is MISSING when isSidechain is not true', () => {
        process.env['HOME'] = fakeHarness('sess-5', 'checklist-reviewer', 'dean/feat', 1, false);
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-5';
        expect(svc.verify('checklist-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('is MISSING when the session has no subagents dir at all', () => {
        process.env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-empty-'));
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-none';
        expect(svc.verify('checklist-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });
});

// A harness dir with N distinct agents (each its own agentType + agentId) on one branch.
function fakeHarnessMulti(sessionId: string, agentTypes: string[], branch: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-multi-'));
    const dir = path.join(home, '.claude', 'projects', '-Slug', sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    agentTypes.forEach((t: string, i: number): void => {
        fs.writeFileSync(path.join(dir, `agent-a${i}.meta.json`), JSON.stringify({ agentType: t, spawnDepth: 1 }));
        fs.writeFileSync(path.join(dir, `agent-a${i}.jsonl`), JSON.stringify({ isSidechain: true, gitBranch: branch }) + '\n');
    });
    return home;
}

describe('SubagentProvenanceService.verifyDistinct', () => {
    it('OK when every expected subagent ran as a distinct run', () => {
        process.env['HOME'] = fakeHarnessMulti('sess-d1', ['envvars-reviewer', 'migrations-reviewer'], 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-d1';
        expect(svc.verifyDistinct(['envvars-reviewer', 'migrations-reviewer'], 'dean/feat').status).toBe(PROVENANCE_OK);
    });

    it('MISSING (naming the culprit) when one expected subagent never ran', () => {
        process.env['HOME'] = fakeHarnessMulti('sess-d2', ['envvars-reviewer'], 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-d2';
        const res = svc.verifyDistinct(['envvars-reviewer', 'migrations-reviewer'], 'dean/feat');
        expect(res.status).toBe(PROVENANCE_MISSING);
        expect(res.detail).toMatch(/migrations-reviewer/);
    });

    it('OK immediately for an empty expected set', () => {
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        expect(svc.verifyDistinct([], 'dean/feat').status).toBe(PROVENANCE_OK);
    });

    it('is branch-scoped: a run recorded under a DIFFERENT session still counts (review once per branch)', () => {
        // The reviewer ran in session "old-session"; we are now in a NEW session "new-session".
        process.env['HOME'] = fakeHarnessMulti('old-session', ['checklist-migrations'], 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'new-session';
        expect(svc.verifyDistinct(['checklist-migrations'], 'dean/feat').status).toBe(PROVENANCE_OK);
    });

    it('SKIPPED without a session id', () => {
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        expect(svc.verifyDistinct(['r'], 'dean/feat').status).toBe(PROVENANCE_SKIPPED);
    });
});

/**
 * ONE shared primary clone for the whole block, and one linked worktree per case off it.
 *
 * Deliberately shared rather than a fresh clone per test. Each `git init` + config + commit is five
 * process spawns, and this file's cases all need a real repo; building one per test put ~60 git
 * processes on the box and pushed the (already slow, timing-sensitive) main-sync integration specs
 * running alongside it past their 45s timeout — a red build-all caused entirely by test setup cost.
 * Sharing is safe here because no case mutates the clone: every one gets its own worktree on its own
 * branch, which is what `git worktree` is for.
 */
let sharedClone = '';

function clone(): string {
    if (sharedClone === '') sharedClone = cloneOnBranch('main');
    return sharedClone;
}

// A real git repo (a PRIMARY CLONE) on `branch`. Real rather than mocked because the whole point of the
// fix is that we ask GIT, not the transcript.
function cloneOnBranch(branch: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-repo-'));
    git(repo, 'init', '-q', '-b', branch);
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    return repo;
}

// A LINKED WORKTREE of the shared clone, on a new branch — the shape a reviewer subagent actually runs
// in, and the only cwd shape the fix will derive a branch from.
function worktreeOn(branch: string): string {
    const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wt-')), 'tree');
    git(clone(), 'worktree', 'add', '-q', '-b', branch, wt);
    return wt;
}

function git(cwd: string, ...args: string[]): void {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

// One agent whose record-0 carries an explicit `gitBranch` AND an explicit `cwd` — the two fields the
// harness writes and which were observed to CONTRADICT each other.
function harnessWithCwd(sessionId: string, agentType: string, gitBranch: string, cwd: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-cwd-'));
    const dir = path.join(home, '.claude', 'projects', '-Slug', sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-abc.meta.json'), JSON.stringify({ agentType, spawnDepth: 2 }));
    fs.writeFileSync(path.join(dir, 'agent-abc.jsonl'), JSON.stringify({ isSidechain: true, gitBranch, cwd }) + '\n');
    return home;
}

// eslint-disable-next-line @typescript-eslint/max-params
function statusFor(sessionId: string, agentType: string, gitBranch: string, cwd: string, target: string): string {
    process.env['HOME'] = harnessWithCwd(sessionId, agentType, gitBranch, cwd);
    process.env['CLAUDE_CODE_SESSION_ID'] = sessionId;
    return new SubagentProvenanceService().verifyDistinct([agentType], target).status;
}

describe('SubagentProvenanceService — a PINNED cwd decides when gitBranch contradicts it', () => {
    it('credits a reviewer whose gitBranch is WRONG but whose own worktree is on the target branch', () => {
        // The live defect: the harness stamped an unrelated worktree's scaffold branch onto a reviewer
        // that really did run in a worktree on dean/one-2406-…, and wp-finish refused the PR four times.
        const target = 'dean/one-2406-acme-api-auth-observe-header-constant';
        expect(statusFor('sess-c1', 'ticket-key-required', 'worktree-agent-a54887200e40eb956', worktreeOn(target), target))
            .toBe(PROVENANCE_OK);
    });

    it('BLOCKS a stale reviewer whose cwd is the PRIMARY CLONE, even though the clone now sits on the target', () => {
        // THE FALSE-ACCEPT an unguarded cwd fallback opens. The reviewer ran in the clone while it was on
        // dean/old-work; the clone was later checked out to dean/feat; finish now runs on dean/feat. Asking
        // git would answer dean/feat — because the CLONE moved, not because this reviewer saw dean/feat.
        // A primary clone is never pinned, so it is never an oracle: BLOCK. Its own clone (not the shared
        // one) precisely because this case is the one that MUTATES what branch the clone is on.
        const moved = cloneOnBranch('dean/old-work');
        git(moved, 'checkout', '-q', '-b', 'dean/feat');
        expect(statusFor('sess-c2', 'checklist-reviewer', 'dean/old-work', moved, 'dean/feat'))
            .toBe(PROVENANCE_MISSING);
    });

    it('still BLOCKS when gitBranch is wrong AND the worktree is on a different branch', () => {
        expect(statusFor('sess-c3', 'checklist-reviewer', 'worktree-agent-aaaa', worktreeOn('dean/some-other-work'), 'dean/feat'))
            .toBe(PROVENANCE_MISSING);
    });

    it('still BLOCKS when gitBranch is wrong and the cwd worktree was reaped', () => {
        const gone = path.join(os.tmpdir(), 'wp-reaped-worktree-that-does-not-exist');
        expect(statusFor('sess-c4', 'checklist-reviewer', 'worktree-agent-aaaa', gone, 'dean/feat'))
            .toBe(PROVENANCE_MISSING);
    });

    it('still BLOCKS when gitBranch is wrong and the cwd is not a git repo at all', () => {
        const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-not-a-repo-'));
        expect(statusFor('sess-c5', 'checklist-reviewer', 'worktree-agent-aaaa', notARepo, 'dean/feat'))
            .toBe(PROVENANCE_MISSING);
    });

    it('still BLOCKS when gitBranch is wrong and record-0 carries no cwd to fall back on', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-nocwd-'));
        const dir = path.join(home, '.claude', 'projects', '-Slug', 'sess-c6', 'subagents');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'r', spawnDepth: 1 }));
        fs.writeFileSync(path.join(dir, 'agent-abc.jsonl'), JSON.stringify({ isSidechain: true, gitBranch: 'wrong' }) + '\n');
        process.env['HOME'] = home;
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-c6';
        expect(new SubagentProvenanceService().verifyDistinct(['r'], 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('does not consult git when gitBranch already agrees — even a primary-clone cwd still short-circuits', () => {
        expect(statusFor('sess-c7', 'checklist-reviewer', 'dean/feat', clone(), 'dean/feat')).toBe(PROVENANCE_OK);
    });

    it('still tolerates a leftover wpN suffix on the branch derived from a worktree cwd', () => {
        expect(statusFor('sess-c8', 'checklist-reviewer', 'worktree-agent-aaaa', worktreeOn('dean/feat-wp2'), 'dean/feat'))
            .toBe(PROVENANCE_OK);
    });

    it('credits a SLASH-form branch through the cwd path — the comparison never sees a dash-sanitized name', () => {
        // The dash-form (dean-one-2406-…) is the on-disk pr-review DIR name only, and provenance.json now
        // calls it `featureSlug` for that reason. What reaches verifyDistinct is `git branch --show-current`,
        // i.e. slash-form, and so is what a worktree cwd resolves to. No normalization is missing.
        const wt = worktreeOn('dean/one-2406-acme-api-auth');
        expect(statusFor('sess-c9', 'checklist-reviewer', 'main', wt, 'dean/one-2406-acme-api-auth')).toBe(PROVENANCE_OK);
        // …and the dash-form spelling is NOT accepted, confirming no sanitized name is silently matched.
        expect(statusFor('sess-c10', 'checklist-reviewer', 'main', wt, 'dean-one-2406-acme-api-auth')).toBe(PROVENANCE_MISSING);
    });

    it('does not credit a detached HEAD, which rev-parse prints as the literal "HEAD"', () => {
        const wt = worktreeOn('dean/feat-detached');
        git(wt, 'checkout', '-q', '--detach', 'HEAD');
        expect(statusFor('sess-c11', 'checklist-reviewer', 'worktree-agent-aaaa', wt, 'HEAD')).toBe(PROVENANCE_MISSING);
    });
});

describe('SubagentProvenanceService.evidenceFor', () => {
    it('carries out the transcript path it read the counters from — the only place it is knowable', () => {
        process.env['HOME'] = fakeHarness('sess-e1', 'envvars-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-e1';
        const result = svc.verifyDistinct(['envvars-reviewer'], 'dean/feat');
        const evidence = svc.evidenceFor(new EvidenceRequest('dean/feat', result.agentIds));
        expect(evidence).toHaveLength(1);
        expect(evidence[0]?.transcriptPath).toMatch(/subagents[/\\]agent-abc\.jsonl$/);
    });

    it('leaves the transcript path empty when the jsonl is not there', () => {
        const home = fakeHarness('sess-e2', 'envvars-reviewer', 'dean/feat');
        fs.rmSync(path.join(home, '.claude', 'projects', '-Some-Slug', 'sess-e2', 'subagents', 'agent-abc.jsonl'));
        process.env['HOME'] = home;
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-e2';
        const result = svc.verifyDistinct(['envvars-reviewer'], 'dean/feat');
        const evidence = svc.evidenceFor(new EvidenceRequest('dean/feat', result.agentIds));
        expect(evidence[0]?.transcriptPath).toBe('');
    });
});

// Append assistant records to the fake transcript, so a test can say what served the reviewer.
function appendRecords(home: string, sessionId: string, records: readonly object[]): void {
    const jsonl = path.join(home, '.claude', 'projects', '-Some-Slug', sessionId, 'subagents', 'agent-abc.jsonl');
    fs.appendFileSync(jsonl, records.map((r: object): string => JSON.stringify(r)).join('\n') + '\n');
}

function modelsFor(sessionId: string, records: readonly object[]): string[] {
    const home = fakeHarness(sessionId, 'envvars-reviewer', 'dean/feat');
    appendRecords(home, sessionId, records);
    process.env['HOME'] = home;
    process.env['CLAUDE_CODE_SESSION_ID'] = sessionId;
    const result = svc.verifyDistinct(['envvars-reviewer'], 'dean/feat');
    return svc.evidenceFor(new EvidenceRequest('dean/feat', result.agentIds))[0]?.models ?? [];
}

/**
 * The OBSERVED model, never the configured one and never a self-report.
 *
 * A `.claude/agents/<subagent>.md` declaring `model: sonnet` was measured running opus — a 2.5x price
 * difference the configured value cannot show. Asking the reviewer instead would be worse: a model is
 * unreliable about its own identity, so the field would be usually right and silently wrong.
 */
describe('SubagentProvenanceService.evidenceFor — which model actually reviewed', () => {
    it('records the model the harness wrote, deduped, in first-seen order', () => {
        expect(modelsFor('sess-m1', [
            { message: { model: 'claude-sonnet-5', content: [] } },
            { message: { model: 'claude-sonnet-5', content: [] } },
        ])).toEqual(['claude-sonnet-5']);
    });

    // An ARRAY because one run can span models — a fallback after a refusal, a mid-run config change.
    // Collapsing to one value would force a lossy choice at read time.
    it('keeps every model when a run spans more than one', () => {
        expect(modelsFor('sess-m2', [
            { message: { model: 'claude-sonnet-5', content: [] } },
            { message: { model: 'claude-opus-5', content: [] } },
        ])).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    });

    // `<synthetic>` records are written by the harness for messages no model produced. Counting one
    // would put a non-model in the field, on every single reviewer.
    it('skips <synthetic> records rather than filing them as a model', () => {
        expect(modelsFor('sess-m3', [
            { message: { model: '<synthetic>', content: [] } },
            { message: { model: 'claude-opus-5', content: [] } },
        ])).toEqual(['claude-opus-5']);
    });

    /**
     * Best-effort, like every other read of this file: this is quality telemetry, not an integrity
     * gate, so a transcript with no model field must yield empty and never block a PR.
     */
    it('yields no models rather than throwing when the field is absent', () => {
        expect(modelsFor('sess-m4', [{ message: { content: [] } }, { message: {} }])).toEqual([]);
    });

    // One pass, both answers: the models must not cost a second read of the largest file this opens.
    it('still counts tool calls from the same pass that collected the models', () => {
        const home = fakeHarness('sess-m5', 'envvars-reviewer', 'dean/feat');
        appendRecords(home, 'sess-m5', [
            { message: { model: 'claude-opus-5', content: [{ type: 'tool_use', input: { file_path: '/repo/x.ts' } }] } },
        ]);
        process.env['HOME'] = home;
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-m5';
        const result = svc.verifyDistinct(['envvars-reviewer'], 'dean/feat');
        const evidence = svc.evidenceFor(new EvidenceRequest('dean/feat', result.agentIds))[0];
        expect(evidence?.models).toEqual(['claude-opus-5']);
        expect(evidence?.toolCallCount).toBe(1);
    });
});
