import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistValidator } from './checklist-validator';
import { ChecklistDefinition, toChecklist } from './checklist-config';

const svc = new ChecklistValidator();

/**
 * A scratch repo. `docs` are written under `.claude/review/`; `agents` become `.claude/agents/<name>.md`.
 * Passing agents:[] deliberately leaves NO agents dir — the non-Claude-Code consumer case where the
 * reviewer-agent existence check must stay off.
 */
function repoWith(docs: string[] = [], agents: string[] = []): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cklv-'));
    fs.mkdirSync(path.join(dir, '.claude', 'review'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(dir, '.claude', 'review', d), '# doc');
    if (agents.length > 0) {
        fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
        for (const a of agents) fs.writeFileSync(path.join(dir, '.claude', 'agents', `${a}.md`), '# agent');
    }
    return dir;
}

function defs(items: readonly { subagent?: string; doc?: string; patterns?: string[] }[]): ChecklistDefinition[] {
    return items.map((i: { subagent?: string; doc?: string; patterns?: string[] }): ChecklistDefinition => toChecklist(i));
}

describe('ChecklistValidator', () => {
    it('accepts a valid set', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        expect(svc.validate(dir, defs([{ subagent: 'db-reviewer', doc: '.claude/review/db.md', patterns: ['**/*.sql'] }]))).toEqual([]);
    });

    it('accepts an entry with no doc — the reviewer just reads the diff', () => {
        const dir = repoWith([], ['db-reviewer']);
        expect(svc.validate(dir, defs([{ subagent: 'db-reviewer' }]))).toEqual([]);
    });

    it('rejects an empty subagent — it has no id, so it could key no verdict file', () => {
        const errors = svc.validate(repoWith(), defs([{ doc: '' }]));
        expect(errors.some((e: string): boolean => /checklists\[0\].subagent must be a non-empty string/.test(e))).toBe(true);
    });

    it('rejects a duplicate subagent — distinct reviewers ARE the independence guarantee', () => {
        const dir = repoWith([], ['r']);
        expect(svc.validate(dir, defs([{ subagent: 'r' }, { subagent: 'r' }])).some((e: string): boolean => /duplicate subagent "r"/.test(e))).toBe(true);
    });

    it('rejects a doc that does not exist, and says paths are repo-relative', () => {
        const dir = repoWith([], ['r']);
        const errors = svc.validate(dir, defs([{ subagent: 'r', doc: '.claude/review/gone.md' }]));
        expect(errors.some((e: string): boolean => e.includes('.claude/review/gone.md'))).toBe(true);
        expect(errors.some((e: string): boolean => e.includes('REPO-relative'))).toBe(true);
    });

    // Every error must name the one place checklists are configured, so a reader knows what to open.
    it('cites pr-gate.checklists in webpieces.config.json on every error', () => {
        const dir = repoWith([], ['r']);
        const errors = svc.validate(dir, defs([{ subagent: 'r', doc: '.claude/review/gone.md' }]));
        expect(errors.every((e: string): boolean => e.includes('pr-gate.checklists in webpieces.config.json'))).toBe(true);
    });
});

/**
 * The check that was missing before: `subagent` is the ONE required field and the distinct-reviewer guarantee
 * rests on it, yet nothing confirmed it named a real agent. A typo validated clean, then got printed as
 * "spawn this" — and since wp-finish blocks on review-<typo>.json, the coding agent's easiest path became
 * writing the reviewer's verdict itself: exactly the self-certification the rule exists to prevent.
 */
describe('ChecklistValidator — the reviewer subagent must actually exist', () => {
    it('rejects a subagent with no .claude/agents/<name>.md', () => {
        const dir = repoWith([], ['deploy-infra-reviewer']);
        const errors = svc.validate(dir, defs([{ subagent: 'deploy-infra-revewer' }]));
        expect(errors.some((e: string): boolean => /names no reviewer/.test(e))).toBe(true);
        expect(errors.some((e: string): boolean => e.includes('deploy-infra-revewer.md'))).toBe(true);
    });

    it('explains the consequence, so the AI does not "fix" it by self-certifying', () => {
        const errors = svc.validate(repoWith([], ['x']), defs([{ subagent: 'typo' }]));
        expect(errors.join('\n')).toContain('review-typo.json');
        expect(errors.join('\n')).toContain('Create that agent file or fix the name');
    });

    it('accepts it when the agent file is there', () => {
        const dir = repoWith([], ['deploy-infra-reviewer']);
        expect(svc.validate(dir, defs([{ subagent: 'deploy-infra-reviewer' }]))).toEqual([]);
    });

    // A consumer driving the gate outside Claude Code has no .claude/agents dir at all; checking for one
    // would break them over a directory they were never expected to have.
    it('stays off entirely when the repo has no .claude/agents dir', () => {
        expect(svc.validate(repoWith(), defs([{ subagent: 'nobody-at-all' }]))).toEqual([]);
    });
});
