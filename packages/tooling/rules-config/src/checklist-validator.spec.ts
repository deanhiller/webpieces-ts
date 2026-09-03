import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistValidator } from './checklist-validator';
import { ChecklistDefinition, RawChecklistItem, toChecklist } from './checklist-config';
import { findConfigFile } from './config-file';
import { validateChecklistDocs } from './checklist-docs-validator';

const svc = new ChecklistValidator();

/**
 * THIS repo's live `commands.pr-gate.checklists`, read straight off disk. Returns [] when there is no
 * config to find, so the block below stays silent in a consumer repo rather than failing there.
 */
function liveChecklists(configPath: string | null): ChecklistDefinition[] {
    if (configPath === null) return [];
    // webpieces-disable no-any-unknown -- parsed config JSON is opaque until narrowed on the next line
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const commands = raw['commands'] as Record<string, unknown> | undefined;
    const prGate = commands?.['pr-gate'] as Record<string, unknown> | undefined;
    const items = (prGate?.['checklists'] ?? []) as RawChecklistItem[];
    return items.map((i: RawChecklistItem): ChecklistDefinition => toChecklist(i));
}

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

/**
 * THIS repo's own live `commands.pr-gate.checklists`, validated against the files on disk.
 *
 * Every case above runs against a scratch repo, which proves the validator works and proves nothing
 * about whether the config beside it is wired correctly. This block closes that gap: it is the test that
 * would have caught a checklist naming a doc or an agent file nobody ever created — the failure mode
 * where the gate cheerfully tells a reviewer to open a path that does not exist and the reviewer's
 * easiest way out is to certify itself.
 *
 * `findConfigFile` / `validateChecklistDocs` walk UP from the cwd, so this works whether vitest is
 * launched from the project directory or the workspace root, and both stay silent (return [] / no
 * errors) in a repo that has no webpieces.config.json at all.
 */
describe("this repo's own pr-gate checklists are wired to files that exist", () => {
    const configPath = findConfigFile(process.cwd());
    const repoRoot = configPath === null ? '' : path.dirname(configPath);
    const live = liveChecklists(configPath);

    it('validates clean — every doc and every reviewer agent file is on disk', () => {
        expect(validateChecklistDocs(process.cwd())).toEqual([]);
    });

    // Named one by one rather than counted: a count stays green when one reviewer is silently swapped for
    // another, and each of these enforces a policy this repo has already violated once in anger.
    it.each([
        'backwards-compat-reviewer',
        'error-output-reviewer',
        'experiment-lifecycle-reviewer',
    ])('%s is registered, REQUIRED, and names a doc and an agent file that exist', (subagent: string) => {
        const entry = live.find((c: ChecklistDefinition): boolean => c.subagent === subagent);
        expect(entry, `${subagent} is missing from commands.pr-gate.checklists`).toBeDefined();
        const found = entry as ChecklistDefinition;
        expect(found.required).toBe(true);
        expect(found.patterns.length).toBeGreaterThan(0);
        expect(found.doc).not.toBe('');
        expect(fs.existsSync(path.join(repoRoot, found.doc)), `missing doc ${found.doc}`).toBe(true);
        const agentFile = path.join(repoRoot, '.claude', 'agents', `${subagent}.md`);
        expect(fs.existsSync(agentFile), `missing agent file ${agentFile}`).toBe(true);
    });

    /**
     * `experiment-lifecycle-reviewer`'s EXACT pattern list, which the case above can only assert is
     * non-empty. The reviewer's subject is a SETTING an AI must not end, and that decision shows up in
     * the flags and their read paths under `packages/**`, in the config, and in the "ships OFF and
     * stays OFF for two years" policy prose — which now lives in `.claude/rules/**`, having moved out
     * of `CLAUDE.md` when that file became a routing index (`CLAUDE.md` stays on the list because it
     * still carries the rules an agent must obey unprompted). A checklist watching only `packages/**`
     * would miss a diff that ends an experiment by editing the policy sentence — so a narrowing of this
     * list is a silent hole, and this is the case that goes red for it.
     */
    it('experiment-lifecycle-reviewer watches code, config AND policy prose', () => {
        if (configPath === null) return;
        const entry = live.find(
            (c: ChecklistDefinition): boolean => c.subagent === 'experiment-lifecycle-reviewer');
        expect(entry, 'experiment-lifecycle-reviewer is missing from commands.pr-gate.checklists').toBeDefined();
        expect((entry as ChecklistDefinition).patterns)
            .toEqual(['packages/**', 'webpieces.config.json', 'CLAUDE.md', '.claude/rules/**']);
    });
});
