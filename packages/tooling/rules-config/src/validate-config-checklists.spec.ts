import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validatePrGateSection } from './validate-config';

/**
 * `pr-gate.checklists` validation, split out of validate-config.spec.ts when that file hit the
 * max-file-lines limit. It is a coherent slice rather than an arbitrary cut: every test here is about the
 * ONE section, and it owns the two fixtures (`validPrGate`, `repoWith`) that only these tests need.
 */

// A pr-gate section that is valid except for whatever `checklists` value the test is probing.
function validPrGate(checklists: unknown): Record<string, unknown> {
    return { mode: 'ON', buildCommand: 'pnpm ci', mergeMode: 'AUTO', gates: [], checklists };
}

// A temp repo root, optionally with `.claude/review/<doc>` files and `.claude/agents/<name>.md` reviewers.
function repoWith(docs: string[] = [], agents: string[] = []): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-checklists-'));
    fs.mkdirSync(path.join(dir, '.claude', 'review'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(dir, '.claude', 'review', d), '# doc');
    if (agents.length > 0) {
        fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
        for (const a of agents) fs.writeFileSync(path.join(dir, '.claude', 'agents', `${a}.md`), '# agent');
    }
    return dir;
}

describe('validatePrGateSection checklists — the array in webpieces.config.json is the ONLY shape', () => {
    it('accepts a well-formed array with repo-relative docs', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { subagent: 'db-reviewer', doc: '.claude/review/db.md', patterns: ['**/*.sql'], required: true },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('REJECTS an entry that omits "required" — there is no default in either direction', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { subagent: 'db-reviewer', doc: '.claude/review/db.md' },
        ]), dir);
        // The message must name the entry AND both edits: only the consumer knows which this checklist is.
        expect(errors.some((e: string): boolean => /checklists\[0\] \("db-reviewer"\) is missing "required"/.test(e))).toBe(true);
        expect(errors.some((e: string): boolean => /"required": true/.test(e) && /"required": false/.test(e))).toBe(true);
    });

    it('rejects a non-boolean "required"', () => {
        const errors = validatePrGateSection(validPrGate([{ subagent: 'r', required: 'true' }]));
        expect(errors.some((e: string): boolean => /checklists\[0\] \("r"\)\.required must be a boolean/.test(e))).toBe(true);
    });

    it('accepts required:false — an OPTIONAL checklist the human may decline', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { subagent: 'db-reviewer', doc: '.claude/review/db.md', required: false },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('a repo may declare ZERO required checklists — every one of them optional is a valid choice', () => {
        const dir = repoWith([], ['a', 'b']);
        const errors = validatePrGateSection(validPrGate([
            { subagent: 'a', required: false }, { subagent: 'b', required: false },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('resolves item docs REPO-relative — a bare filename is not found', () => {
        const dir = repoWith(['db.md'], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([{ subagent: 'db-reviewer', doc: 'db.md' }]), dir);
        expect(errors.some((e: string): boolean => /\.doc "db\.md" does not exist/.test(e))).toBe(true);
    });

    it('rejects a non-object entry, a non-string doc, and non-string patterns', () => {
        expect(validatePrGateSection(validPrGate(['nope'])).some((e: string): boolean => /checklists\[0\] must be an object/.test(e))).toBe(true);
        expect(validatePrGateSection(validPrGate([{ subagent: 'r', doc: 7 }])).some((e: string): boolean => /checklists\[0\]\.doc must be a string/.test(e))).toBe(true);
        expect(validatePrGateSection(validPrGate([{ subagent: 'r', patterns: [1] }])).some((e: string): boolean => /checklists\[0\]\.patterns must be a string\[\]/.test(e))).toBe(true);
    });

    it('rejects a duplicate subagent', () => {
        const dir = repoWith([], ['r']);
        const errors = validatePrGateSection(validPrGate([{ subagent: 'r' }, { subagent: 'r' }]), dir);
        expect(errors.some((e: string): boolean => /duplicate subagent "r"/.test(e))).toBe(true);
    });

    it('rejects a subagent with no .claude/agents/<name>.md', () => {
        const dir = repoWith([], ['db-reviewer']);
        const errors = validatePrGateSection(validPrGate([{ subagent: 'db-revewer' }]), dir);
        expect(errors.some((e: string): boolean => /names no reviewer/.test(e))).toBe(true);
    });

    it('leaves the reviewer-agent check off for a repo with no .claude/agents dir', () => {
        const dir = repoWith();
        expect(validatePrGateSection(validPrGate([{ subagent: 'nobody', required: true }]), dir)).toEqual([]);
    });

    it('an empty array is valid — it means "no checklists"', () => {
        expect(validatePrGateSection(validPrGate([]), repoWith())).toEqual([]);
    });
});

/**
 * The `{ doc }` manifest shape is REMOVED, not deprecated. A consumer still on it must FAIL — loudly, with
 * the exact edit — rather than be quietly carried along by a compatibility branch. This is the whole point:
 * an AI applies the printed migration in one pass, so permanent duality buys nothing.
 */
describe('validatePrGateSection rejects the removed { doc } manifest shape', () => {
    const legacy = { doc: '.claude/review/index.md' };

    it('fails, and never silently accepts it', () => {
        expect(validatePrGateSection(validPrGate(legacy)).length).toBeGreaterThan(0);
    });

    it('names the doc the consumer pointed at, so they know which file holds the array to move', () => {
        const err = validatePrGateSection(validPrGate(legacy)).join('\n');
        expect(err).toContain('.claude/review/index.md');
        expect(err).toContain('REMOVED');
    });

    it('spells out the migration, including that entry docs become REPO-relative', () => {
        const err = validatePrGateSection(validPrGate(legacy)).join('\n');
        expect(err).toContain('webpieces:checklists');
        expect(err).toContain('REPO-relative');
        expect(err).toContain('"checklists": <that array>');
    });

    // Even with a repoRoot to inspect, there is no path that reads the manifest doc any more.
    it('fails identically when a repoRoot is available — nothing reads the doc now', () => {
        const dir = repoWith(['index.md']);
        expect(validatePrGateSection(validPrGate(legacy), dir).join('\n')).toContain('REMOVED');
    });

    it('still fails when doc is empty or the object is otherwise empty', () => {
        expect(validatePrGateSection(validPrGate({ doc: '' })).length).toBeGreaterThan(0);
    });
});

describe('validatePrGateSection rejects every non-array checklists value', () => {
    it('rejects a string, a number, and null with the array requirement + an example', () => {
        for (const bad of ['nope', 7, null]) {
            const errors = validatePrGateSection(validPrGate(bad));
            expect(errors.some((e: string): boolean => /"checklists" must be an ARRAY/.test(e))).toBe(true);
        }
    });
});
