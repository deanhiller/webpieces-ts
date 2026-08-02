import { describe, it, expect, afterEach } from 'vitest';
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
        const res = svc.verify('morpheus-reviewer', 'dean/feat');
        expect(res.status).toBe(PROVENANCE_SKIPPED);
    });

    it('verifies OK when a matching subagent ran on this branch', () => {
        process.env['HOME'] = fakeHarness('sess-1', 'morpheus-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-1';
        expect(svc.verify('morpheus-reviewer', 'dean/feat').status).toBe(PROVENANCE_OK);
    });

    it('tolerates a leftover wpN branch-rename suffix', () => {
        process.env['HOME'] = fakeHarness('sess-2', 'morpheus-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-2';
        expect(svc.verify('morpheus-reviewer', 'dean/feat-wp3').status).toBe(PROVENANCE_OK);
    });

    it('is MISSING when no subagent of that agentType ran', () => {
        process.env['HOME'] = fakeHarness('sess-3', 'some-other-agent', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-3';
        expect(svc.verify('morpheus-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('is MISSING when spawnDepth < 1 (the main loop, not a subagent)', () => {
        process.env['HOME'] = fakeHarness('sess-4', 'morpheus-reviewer', 'dean/feat', 0);
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-4';
        expect(svc.verify('morpheus-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('is MISSING when isSidechain is not true', () => {
        process.env['HOME'] = fakeHarness('sess-5', 'morpheus-reviewer', 'dean/feat', 1, false);
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-5';
        expect(svc.verify('morpheus-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
    });

    it('is MISSING when the session has no subagents dir at all', () => {
        process.env['HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-empty-'));
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-none';
        expect(svc.verify('morpheus-reviewer', 'dean/feat').status).toBe(PROVENANCE_MISSING);
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
        process.env['HOME'] = fakeHarnessMulti('old-session', ['morpheus-migrations'], 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'new-session';
        expect(svc.verifyDistinct(['morpheus-migrations'], 'dean/feat').status).toBe(PROVENANCE_OK);
    });

    it('SKIPPED without a session id', () => {
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        expect(svc.verifyDistinct(['r'], 'dean/feat').status).toBe(PROVENANCE_SKIPPED);
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
