import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistValidator } from './checklist-validator';
import {
    ChecklistDefinition, RawChecklistItem, REVIEWER_AGENTS_ONE_PER_CHECKLIST, ReviewerAgentPolicy, toChecklist,
} from './checklist-config';
import { CONFIG_FILENAME } from './config-file';
import { validateChecklistDocs } from './checklist-docs-validator';

const svc = new ChecklistValidator();
const POLICY = new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_ONE_PER_CHECKLIST);

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

function defs(items: readonly RawChecklistItem[]): ChecklistDefinition[] {
    return items.map((i: RawChecklistItem): ChecklistDefinition => toChecklist(i, POLICY));
}

describe('ChecklistValidator', () => {
    it('accepts a valid set', () => {
        const dir = repoWith(['db.md']);
        expect(svc.validate(dir, defs([{ id: 'db', doc: '.claude/review/db.md', patterns: ['**/*.sql'] }]))).toEqual([]);
    });

    it('rejects an entry with no doc — the generic reviewer has nothing else to review against', () => {
        const errors = svc.validate(repoWith(), defs([{ id: 'db' }]));
        expect(errors.some((e: string): boolean => /"db"\.doc is required/.test(e))).toBe(true);
    });

    it('rejects an empty id — it could key no verdict file', () => {
        const errors = svc.validate(repoWith(), defs([{ doc: '' }]));
        expect(errors.some((e: string): boolean => /checklists\[0\]\.id must be a non-empty string/.test(e))).toBe(true);
    });

    it('rejects a duplicate id — each checklist writes its own verdict file', () => {
        const dir = repoWith(['a.md']);
        const errors = svc.validate(dir, defs([
            { id: 'r', doc: '.claude/review/a.md' }, { id: 'r', doc: '.claude/review/a.md' },
        ]));
        expect(errors.some((e: string): boolean => /duplicate id "r"/.test(e))).toBe(true);
    });

    it('rejects an id that is not file-name safe', () => {
        const errors = svc.validate(repoWith(['a.md']), defs([{ id: 'a/b', doc: '.claude/review/a.md' }]));
        expect(errors.some((e: string): boolean => /must use only letters/.test(e))).toBe(true);
    });

    it('rejects a doc that does not exist, and says paths are repo-relative', () => {
        const errors = svc.validate(repoWith(), defs([{ id: 'r', doc: '.claude/review/gone.md' }]));
        expect(errors.some((e: string): boolean => e.includes('.claude/review/gone.md'))).toBe(true);
        expect(errors.some((e: string): boolean => e.includes('REPO-relative'))).toBe(true);
    });

    it('skips the doc-existence check on a structure-only validation (no repoRoot)', () => {
        expect(svc.validate(undefined, defs([{ id: 'r', doc: '.claude/review/gone.md' }]))).toEqual([]);
    });

    // Every error must name the one place checklists are configured, so a reader knows what to open.
    it('cites pr-gate.checklists in webpieces.config.json on every error', () => {
        const errors = svc.validate(repoWith(), defs([{ id: 'r', doc: '.claude/review/gone.md' }]));
        expect(errors.every((e: string): boolean => e.includes('pr-gate.checklists in webpieces.config.json'))).toBe(true);
    });
});

/**
 * The reviewer agent is repo-wide now (webpieces-reviewer, or the `overrideReviewerAgent` name), so it is checked ONCE. A typo
 * that validated clean would be printed as "spawn this", and the coding agent's easiest way past the
 * resulting block would be writing the verdicts itself — the self-certification the gate exists to prevent.
 */
describe('ChecklistValidator.validateReviewerAgent — the reviewer agent must actually exist', () => {
    it('rejects a missing webpieces-reviewer and names pnpm wp-upgrade-shim as the cure', () => {
        const errors = svc.validateReviewerAgent(repoWith([], ['other']), POLICY);
        expect(errors.join('\n')).toContain('.claude/agents/webpieces-reviewer.md does not exist');
        expect(errors.join('\n')).toContain('pnpm wp-upgrade-shim');
    });

    it('tells a repo-owned agent name to create the file instead', () => {
        const errors = svc.validateReviewerAgent(
            repoWith([], ['other']), new ReviewerAgentPolicy('typo-reviewer', REVIEWER_AGENTS_ONE_PER_CHECKLIST));
        expect(errors.join('\n')).toContain('typo-reviewer.md');
        expect(errors.join('\n')).toContain('Create that agent file');
        expect(errors.join('\n')).not.toContain('wp-upgrade-shim');
    });

    it('accepts it when the agent file is there', () => {
        expect(svc.validateReviewerAgent(repoWith([], ['webpieces-reviewer']), POLICY)).toEqual([]);
    });

    // A consumer driving the gate outside Claude Code has no .claude/agents dir at all; checking for one
    // would break them over a directory they were never expected to have.
    it('stays off entirely when the repo has no .claude/agents dir', () => {
        expect(svc.validateReviewerAgent(repoWith(), POLICY)).toEqual([]);
    });
});

/**
 * The isolated `validate-checklist-docs` entry point, end to end against a FIXTURE repo shaped like this
 * repo's own four required checklists in the new `id` form.
 *
 * This used to validate THIS repo's live `commands.pr-gate.checklists`. It cannot in this release: the live
 * config is still on the retired `subagent` key, because the repo runs the PUBLISHED validator, which does
 * not know `id` / `reviewerAgentName` yet (see .claude/rules/published-vs-local-source.md). Adopting the new
 * shape in the live config — and pointing this block back at it — is the follow-up PR tracked on #938.
 */
describe('validateChecklistDocs validates a repo wired to files that exist', () => {
    const REQUIRED = [
        { id: 'backwards-compat', doc: '.claude/review/backwards-compatibility.md', patterns: ['packages/**'], required: true },
        { id: 'error-output', doc: '.claude/review/error-output.md', patterns: ['packages/**'], required: true },
        { id: 'experiment-lifecycle', doc: '.claude/review/experiment-lifecycle.md', patterns: ['packages/**', '.claude/rules/**'], required: true },
        { id: 'ticket-required', doc: '.claude/review/ticket-required.md', patterns: ['**', '.claude/**', '.github/**'], required: true },
    ];

    function fixtureRepo(checklists: unknown[]): string {
        const dir = repoWith(
            ['backwards-compatibility.md', 'error-output.md', 'experiment-lifecycle.md', 'ticket-required.md'],
            ['webpieces-reviewer']);
        fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({
            commands: { 'pr-gate': { mode: 'ON', buildCommand: 'x', mergeMode: 'NONE', checklists } },
        }));
        return dir;
    }

    it('validates clean — every doc is on disk', () => {
        expect(validateChecklistDocs(fixtureRepo(REQUIRED))).toEqual([]);
    });

    it('reports a doc that is not on disk', () => {
        const errors = validateChecklistDocs(fixtureRepo([{ id: 'x', doc: '.claude/review/nope.md', required: true }]));
        expect(errors.some((e: string): boolean => e.includes('nope.md'))).toBe(true);
    });

    it('reports the retired subagent key', () => {
        const errors = validateChecklistDocs(fixtureRepo([
            { subagent: 'x-reviewer', doc: '.claude/review/error-output.md', required: true },
        ]));
        expect(errors.some((e: string): boolean => e.includes('"subagent" is a RETIRED'))).toBe(true);
    });
});
