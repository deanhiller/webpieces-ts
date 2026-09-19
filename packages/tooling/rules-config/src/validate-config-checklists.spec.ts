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
    return { mode: 'ON', buildCommand: 'pnpm ci', mergeMode: 'AUTO', reviewerAgents: 1, gates: [], checklists };
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

const has = (errors: readonly string[], re: RegExp): boolean => errors.some((e: string): boolean => re.test(e));

describe('validatePrGateSection checklists — the array in webpieces.config.json is the ONLY shape', () => {
    it('accepts a well-formed array with repo-relative docs', () => {
        const dir = repoWith(['db.md'], ['webpieces-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { id: 'db', doc: '.claude/review/db.md', patterns: ['**/*.sql'], required: true },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('REJECTS an entry that omits "required" — there is no default in either direction', () => {
        const dir = repoWith(['db.md'], ['webpieces-reviewer']);
        const errors = validatePrGateSection(validPrGate([{ id: 'db', doc: '.claude/review/db.md' }]), dir);
        // The message must name the entry AND both edits: only the consumer knows which this checklist is.
        expect(has(errors, /checklists\[0\] \("db"\) is missing "required"/)).toBe(true);
        expect(has(errors, /"required": true/) && has(errors, /"required": false/)).toBe(true);
    });

    it('rejects a non-boolean "required"', () => {
        const errors = validatePrGateSection(validPrGate([{ id: 'r', doc: 'x.md', required: 'true' }]));
        expect(has(errors, /checklists\[0\] \("r"\)\.required must be a boolean/)).toBe(true);
    });

    it('accepts required:false — an OPTIONAL checklist the human may decline', () => {
        const dir = repoWith(['db.md'], ['webpieces-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { id: 'db', doc: '.claude/review/db.md', required: false },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('a repo may declare ZERO required checklists — every one of them optional is a valid choice', () => {
        const dir = repoWith(['a.md', 'b.md'], ['webpieces-reviewer']);
        const errors = validatePrGateSection(validPrGate([
            { id: 'a', doc: '.claude/review/a.md', required: false },
            { id: 'b', doc: '.claude/review/b.md', required: false },
        ]), dir);
        expect(errors).toEqual([]);
    });

    it('resolves item docs REPO-relative — a bare filename is not found', () => {
        const dir = repoWith(['db.md'], ['webpieces-reviewer']);
        const errors = validatePrGateSection(validPrGate([{ id: 'db', doc: 'db.md', required: true }]), dir);
        expect(has(errors, /\.doc "db\.md" does not exist/)).toBe(true);
    });

    it('REQUIRES a doc — with one generic reviewer agent the doc is the whole checklist', () => {
        const errors = validatePrGateSection(validPrGate([{ id: 'db', required: true }]));
        expect(has(errors, /"db"\.doc is required/)).toBe(true);
    });

    it('rejects a non-object entry, a non-string id/doc, and non-string patterns', () => {
        expect(has(validatePrGateSection(validPrGate(['nope'])), /checklists\[0\] must be an object/)).toBe(true);
        expect(has(validatePrGateSection(validPrGate([{ id: 'r', doc: 7, required: true }])), /checklists\[0\]\.doc must be a string/)).toBe(true);
        expect(has(validatePrGateSection(validPrGate([{ id: 3, doc: 'x.md', required: true }])), /checklists\[0\]\.id must be a string/)).toBe(true);
        expect(has(validatePrGateSection(validPrGate([{ id: 'r', doc: 'x.md', patterns: [1], required: true }])), /checklists\[0\]\.patterns must be a string\[\]/)).toBe(true);
    });

    it('requires a non-empty, unique, file-safe id', () => {
        expect(has(validatePrGateSection(validPrGate([{ doc: 'x.md', required: true }])), /checklists\[0\]\.id must be a non-empty string/)).toBe(true);
        expect(has(validatePrGateSection(validPrGate([{ id: '../evil', doc: 'x.md', required: true }])), /must use only letters/)).toBe(true);
        const dup = validatePrGateSection(validPrGate([
            { id: 'r', doc: 'x.md', required: true }, { id: 'r', doc: 'x.md', required: true },
        ]));
        expect(has(dup, /duplicate id "r"/)).toBe(true);
    });

    it('an empty array is valid — it means "no checklists"', () => {
        expect(validatePrGateSection(validPrGate([]), repoWith())).toEqual([]);
    });
});

/**
 * `subagent` → `id` is a HARD rename (issue #938): the old key fails the load with the edit, and nothing
 * reads it any more — an entry carrying only `subagent` is also an entry with no id.
 */
describe('validatePrGateSection rejects the retired per-checklist "subagent" key', () => {
    it('names the destination', () => {
        const errors = validatePrGateSection(validPrGate([{ subagent: 'db-reviewer', doc: 'x.md', required: true }]));
        expect(has(errors, /checklists\[0\] \[pr-gate\.checklists\] "subagent" is a RETIRED/)).toBe(true);
        expect(has(errors, /moved to "id"/)).toBe(true);
        expect(has(errors, /"reviewerAgentName": "webpieces-reviewer"/)).toBe(false);
    });

    it('does not fall back to it for the id', () => {
        const errors = validatePrGateSection(validPrGate([{ subagent: 'db-reviewer', doc: 'x.md', required: true }]));
        expect(has(errors, /checklists\[0\]\.id must be a non-empty string/)).toBe(true);
    });
});

/**
 * Issue #947: the reviewer agent defaults to webpieces-reviewer, so a new repo writes nothing. Using an agent
 * of your own takes BOTH `"overrideReviewerAgent": true` and `reviewerAgentName`; either one alone is rejected
 * with the edit that fixes it.
 */
describe('validatePrGateSection — overrideReviewerAgent, reviewerAgentName and reviewerAgents', () => {
    const noName = { mode: 'ON', buildCommand: 'pnpm ci', mergeMode: 'AUTO', reviewerAgents: 1 };

    it('accepts a gate that names no reviewer agent at all (the webpieces default)', () => {
        expect(validatePrGateSection(noName)).toEqual([]);
        expect(validatePrGateSection({ ...noName, overrideReviewerAgent: false })).toEqual([]);
    });

    it('rejects reviewerAgentName without the override, naming both cures', () => {
        for (const section of [
            { ...noName, reviewerAgentName: 'webpieces-reviewer' },
            { ...noName, overrideReviewerAgent: false, reviewerAgentName: 'my-reviewer' },
        ]) {
            const text = validatePrGateSection(section).join('\n');
            expect(text).toContain('"reviewerAgentName" is set but "overrideReviewerAgent" is not true');
            expect(text).toContain('remove "reviewerAgentName"');
            expect(text).toContain('set "overrideReviewerAgent": true');
            expect(text).toContain('webpieces-reviewer');
        }
    });

    it('rejects the override with a missing or empty reviewerAgentName, saying to add it', () => {
        for (const section of [
            { ...noName, overrideReviewerAgent: true },
            { ...noName, overrideReviewerAgent: true, reviewerAgentName: '  ' },
            { ...noName, overrideReviewerAgent: true, reviewerAgentName: 7 },
        ]) {
            const text = validatePrGateSection(section).join('\n');
            expect(text).toContain('"overrideReviewerAgent": true needs "reviewerAgentName"');
            expect(text).toContain('"reviewerAgentName": "my-reviewer"');
        }
    });

    it('accepts the override together with a name', () => {
        expect(validatePrGateSection({ ...noName, overrideReviewerAgent: true, reviewerAgentName: 'my-reviewer' })).toEqual([]);
    });

    it('rejects a non-boolean overrideReviewerAgent', () => {
        for (const bad of ['true', 1, null, {}]) {
            const text = validatePrGateSection({ ...noName, overrideReviewerAgent: bad, reviewerAgentName: 'x' }).join('\n');
            expect(text).toContain('"overrideReviewerAgent" = ');
            expect(text).toContain('must be true or false');
        }
    });

    it('does not check any of it when the whole gate is OFF', () => {
        expect(validatePrGateSection({ mode: 'OFF' })).toEqual([]);
    });

    it('rejects a missing default webpieces-reviewer agent file, naming the webpieces cure', () => {
        const errors = validatePrGateSection(validPrGate([]), repoWith([], ['something-else']));
        expect(has(errors, /webpieces reviewer agent "webpieces-reviewer" names no reviewer/)).toBe(true);
        expect(has(errors, /pnpm wp-upgrade-shim/)).toBe(true);
    });

    it('checks the OVERRIDE agent file, and tells the repo to create it rather than run the webpieces cure', () => {
        const errors = validatePrGateSection(
            { ...validPrGate([]), overrideReviewerAgent: true, reviewerAgentName: 'my-reviewer' }, repoWith([], ['webpieces-reviewer']));
        expect(has(errors, /reviewerAgentName "my-reviewer" names no reviewer/)).toBe(true);
        expect(has(errors, /Create that agent file/)).toBe(true);
        expect(has(errors, /wp-upgrade-shim/)).toBe(false);
    });

    it('leaves the reviewer-agent check off for a repo with no .claude/agents dir', () => {
        expect(validatePrGateSection(validPrGate([]), repoWith())).toEqual([]);
    });

    it('accepts a positive integer reviewerAgents', () => {
        for (const n of [1, 2, 8]) expect(validatePrGateSection({ ...validPrGate([]), reviewerAgents: n })).toEqual([]);
    });

    it('rejects a reviewerAgents that is not a positive integer', () => {
        for (const bad of [0, -1, 1.5, '2', null]) {
            const errors = validatePrGateSection({ ...validPrGate([]), reviewerAgents: bad });
            expect(has(errors, /"reviewerAgents" = .* is not valid — it must be a positive integer/), String(bad)).toBe(true);
        }
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
