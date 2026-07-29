import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SubagentProvenanceService, PROVENANCE_OK, PROVENANCE_MISSING, PROVENANCE_SKIPPED,
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

    it('SKIPPED without a session id', () => {
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        expect(svc.verifyDistinct(['r'], 'dean/feat').status).toBe(PROVENANCE_SKIPPED);
    });
});
