import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChecklistManifestService } from './checklist-manifest';

const svc = new ChecklistManifestService();

function repoWith(indexBody: string, docs: string[] = []): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-manifest-'));
    fs.mkdirSync(path.join(dir, '.claude', 'review'), { recursive: true });
    for (const d of docs) fs.writeFileSync(path.join(dir, '.claude', 'review', d), '# doc');
    fs.writeFileSync(path.join(dir, '.claude', 'review', 'index.md'), indexBody);
    return dir;
}

function manifest(items: unknown[]): string {
    return `# review\n\n<!-- webpieces:checklists\n${JSON.stringify(items, null, 2)}\n-->\n\nprose\n`;
}

describe('ChecklistManifestService.load', () => {
    it('parses the JSON block into ChecklistDefinitions (id = subagent)', () => {
        const dir = repoWith(manifest([
            { subagent: 'envvars-reviewer', doc: 'envvars.md', patterns: ['**/.env*'] },
            { subagent: 'migrations-reviewer' },
        ]), ['envvars.md']);
        const defs = svc.load(dir, '.claude/review/index.md');
        expect(defs.map((d): string => d.id)).toEqual(['envvars-reviewer', 'migrations-reviewer']);
        expect(defs[0].patterns).toEqual(['**/.env*']);
        expect(defs[1].patterns).toEqual([]); // omitted → always runs
    });

    it('returns [] for a missing doc / no manifest block / empty doc path', () => {
        expect(svc.load('/nope', '.claude/review/index.md')).toEqual([]);
        expect(svc.load(repoWith('# just prose'), '.claude/review/index.md')).toEqual([]);
        expect(svc.load(repoWith(manifest([])), '')).toEqual([]);
    });

    it('drops entries with no subagent (they can never be satisfied)', () => {
        const dir = repoWith(manifest([{ doc: 'x.md' }, { subagent: 'ok-reviewer' }]));
        expect(svc.load(dir, '.claude/review/index.md').map((d): string => d.id)).toEqual(['ok-reviewer']);
    });
});

describe('ChecklistManifestService.validate', () => {
    it('accepts a valid manifest', () => {
        const dir = repoWith(manifest([{ subagent: 'r', doc: 'r.md' }]), ['r.md']);
        expect(svc.validate(dir, '.claude/review/index.md')).toEqual([]);
    });

    it('flags a missing doc, no block, duplicate subagent, missing subagent, and a bad item doc', () => {
        expect(svc.validate('/nope', '.claude/review/index.md')[0]).toMatch(/does not exist/);
        expect(svc.validate(repoWith('# prose'), '.claude/review/index.md')[0]).toMatch(/no <!-- webpieces:checklists/);
        expect(svc.validate(repoWith(manifest([{ subagent: 'r' }, { subagent: 'r' }])), '.claude/review/index.md').some((e): boolean => /duplicate subagent "r"/.test(e))).toBe(true);
        expect(svc.validate(repoWith(manifest([{ doc: 'x' }])), '.claude/review/index.md').some((e): boolean => /subagent must be a non-empty string/.test(e))).toBe(true);
        expect(svc.validate(repoWith(manifest([{ subagent: 'r', doc: 'gone.md' }])), '.claude/review/index.md').some((e): boolean => /\.doc "gone.md" does not exist/.test(e))).toBe(true);
    });

    it('flags a manifest block that is not valid JSON', () => {
        const dir = repoWith('# x\n<!-- webpieces:checklists\n[ { not json ]\n-->\n');
        expect(svc.validate(dir, '.claude/review/index.md').some((e): boolean => /not a valid JSON array/.test(e))).toBe(true);
    });
});
