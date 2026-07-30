import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistManifestService } from './checklist-manifest';
import { ChecklistSource, toChecklist } from './checklist-config';

const svc = new ChecklistManifestService();
const INDEX = '.claude/review/index.md';

// A source pointing at the legacy manifest doc.
function docSource(doc = INDEX): ChecklistSource {
    return new ChecklistSource([], doc);
}

// A source in the PRIMARY array-in-config shape. `doc` values here are REPO-relative.
function arraySource(items: unknown[]): ChecklistSource {
    // webpieces-disable no-any-unknown -- test fixture mirrors opaque consumer JSON entries
    return new ChecklistSource(items.map((i): ReturnType<typeof toChecklist> => toChecklist(i as Parameters<typeof toChecklist>[0], '')), '');
}

/**
 * A scratch repo. `docs` are written under `.claude/review/`; `agents` become `.claude/agents/<name>.md`.
 * Passing agents:[] deliberately leaves NO agents dir, which is the non-Claude-Code consumer case where the
 * reviewer-agent existence check must stay off.
 */
function repoWith(indexBody: string, docs: string[] = [], agents: string[] = []): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-manifest-'));
    fs.mkdirSync(path.join(dir, '.claude', 'review'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(dir, '.claude', 'review', d), '# doc');
    fs.writeFileSync(path.join(dir, '.claude', 'review', 'index.md'), indexBody);
    if (agents.length > 0) {
        fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
        for (const a of agents) fs.writeFileSync(path.join(dir, '.claude', 'agents', `${a}.md`), '# agent');
    }
    return dir;
}

function manifest(items: unknown[]): string {
    return `# review\n\n<!-- webpieces:checklists\n${JSON.stringify(items, null, 2)}\n-->\n\nprose\n`;
}

describe('ChecklistManifestService.load (legacy manifest doc)', () => {
    it('parses the JSON block into ChecklistDefinitions (id = subagent)', () => {
        const dir = repoWith(manifest([
            { subagent: 'envvars-reviewer', doc: 'envvars.md', patterns: ['**/.env*'] },
            { subagent: 'migrations-reviewer' },
        ]), ['envvars.md']);
        const defs = svc.load(dir, docSource());
        expect(defs.map((d): string => d.id)).toEqual(['envvars-reviewer', 'migrations-reviewer']);
        expect(defs[0].patterns).toEqual(['**/.env*']);
        expect(defs[1].patterns).toEqual([]); // omitted → always runs
    });

    // The whole point of resolving in ONE place: a bare `envvars.md` in the manifest is unresolvable for the
    // reviewer subagent that gets handed it, so load() must hand back the repo-relative path instead.
    it('resolves each entry doc REPO-relative, not relative to the manifest doc', () => {
        const dir = repoWith(manifest([{ subagent: 'envvars-reviewer', doc: 'envvars.md' }]), ['envvars.md']);
        expect(svc.load(dir, docSource())[0].doc).toBe('.claude/review/envvars.md');
    });

    it('returns [] for a missing doc / no manifest block / empty source', () => {
        expect(svc.load('/nope', docSource())).toEqual([]);
        expect(svc.load(repoWith('# just prose'), docSource())).toEqual([]);
        expect(svc.load(repoWith(manifest([])), new ChecklistSource())).toEqual([]);
    });

    it('drops entries with no subagent (they can never be satisfied)', () => {
        const dir = repoWith(manifest([{ doc: 'x.md' }, { subagent: 'ok-reviewer' }]));
        expect(svc.load(dir, docSource()).map((d): string => d.id)).toEqual(['ok-reviewer']);
    });
});

describe('ChecklistManifestService.load (array in webpieces.config.json)', () => {
    it('uses the array and keeps its repo-relative docs verbatim', () => {
        const dir = repoWith('# prose', ['db.md']);
        const defs = svc.load(dir, arraySource([{ subagent: 'db-reviewer', doc: '.claude/review/db.md', patterns: ['**/*.sql'] }]));
        expect(defs).toHaveLength(1);
        expect(defs[0].doc).toBe('.claude/review/db.md');
        expect(defs[0].patterns).toEqual(['**/*.sql']);
    });

    // Both shapes cannot be in force at once, and the config array is the one a tool can read.
    it('the array wins over a manifest doc when a repo somehow has both', () => {
        const dir = repoWith(manifest([{ subagent: 'from-doc' }]));
        const both = new ChecklistSource(arraySource([{ subagent: 'from-config' }]).inline, INDEX);
        expect(svc.load(dir, both).map((d): string => d.id)).toEqual(['from-config']);
    });
});

describe('ChecklistManifestService.validate', () => {
    it('accepts a valid manifest', () => {
        const dir = repoWith(manifest([{ subagent: 'r', doc: 'r.md' }]), ['r.md']);
        expect(svc.validate(dir, docSource())).toEqual([]);
    });

    it('flags a missing doc, no block, duplicate subagent, missing subagent, and a bad item doc', () => {
        expect(svc.validate('/nope', docSource())[0]).toMatch(/does not exist/);
        expect(svc.validate(repoWith('# prose'), docSource())[0]).toMatch(/no <!-- webpieces:checklists/);
        expect(svc.validate(repoWith(manifest([{ subagent: 'r' }, { subagent: 'r' }])), docSource()).some((e): boolean => /duplicate subagent "r"/.test(e))).toBe(true);
        expect(svc.validate(repoWith(manifest([{ doc: 'x' }])), docSource()).some((e): boolean => /subagent must be a non-empty string/.test(e))).toBe(true);
        expect(svc.validate(repoWith(manifest([{ subagent: 'r', doc: 'gone.md' }])), docSource()).some((e): boolean => /does not exist/.test(e))).toBe(true);
    });

    it('flags a manifest block that is not valid JSON', () => {
        const dir = repoWith('# x\n<!-- webpieces:checklists\n[ { not json ]\n-->\n');
        expect(svc.validate(dir, docSource()).some((e): boolean => /not a valid JSON array/.test(e))).toBe(true);
    });

    it('reports a missing item doc by its RESOLVED repo-relative path, so the reader can open it', () => {
        const errors = svc.validate(repoWith(manifest([{ subagent: 'r', doc: 'gone.md' }])), docSource());
        expect(errors.some((e): boolean => e.includes('.claude/review/gone.md'))).toBe(true);
    });
});

// The defect this validator was missing: `subagent` is the ONE required field, the distinct-reviewer
// guarantee rests on it, and a typo used to validate clean — then get printed as "spawn this", leaving the
// coding agent's easiest path to be writing the reviewer's verdict itself.
describe('ChecklistManifestService.validate — the reviewer subagent must actually exist', () => {
    it('rejects a subagent with no .claude/agents/<name>.md', () => {
        const dir = repoWith(manifest([{ subagent: 'deploy-infra-revewer' }]), [], ['deploy-infra-reviewer']);
        const errors = svc.validate(dir, docSource());
        expect(errors.some((e): boolean => /names no reviewer/.test(e))).toBe(true);
        expect(errors.some((e): boolean => e.includes('deploy-infra-revewer.md'))).toBe(true);
    });

    it('accepts it when the agent file is there', () => {
        const dir = repoWith(manifest([{ subagent: 'deploy-infra-reviewer' }]), [], ['deploy-infra-reviewer']);
        expect(svc.validate(dir, docSource())).toEqual([]);
    });

    // A consumer driving the gate outside Claude Code has no .claude/agents dir at all; checking for one
    // would break them for a directory they were never expected to have.
    it('stays off entirely when the repo has no .claude/agents dir', () => {
        const dir = repoWith(manifest([{ subagent: 'nobody-at-all' }]));
        expect(svc.validate(dir, docSource())).toEqual([]);
    });

    it('applies to the array-in-config shape too', () => {
        const dir = repoWith('# prose', [], ['db-reviewer']);
        expect(svc.validate(dir, arraySource([{ subagent: 'db-reviewer' }]))).toEqual([]);
        expect(svc.validate(dir, arraySource([{ subagent: 'db-revewer' }])).some((e): boolean => /names no reviewer/.test(e))).toBe(true);
    });

    // Errors from the array shape must cite the config key, not a doc path that does not exist.
    it('cites pr-gate.checklists for array-shape errors', () => {
        const dir = repoWith('# prose', [], ['db-reviewer']);
        const errors = svc.validate(dir, arraySource([{ subagent: 'db-reviewer', doc: 'nope.md' }]));
        expect(errors.some((e): boolean => e.includes('pr-gate.checklists in webpieces.config.json'))).toBe(true);
    });
});
