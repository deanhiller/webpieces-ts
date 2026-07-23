import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { SyncFlowGuidance } from './sync-flow-guidance';

const guidance = new SyncFlowGuidance();

describe('SyncFlowGuidance — the canonical text', () => {
    it('always shows BOTH pairs, correctly paired', () => {
        const text = guidance.flows().join('\n');
        expect(text).toContain('pnpm wp-start-update');
        expect(text).toContain('pnpm wp-finish-update');
        expect(text).toContain('pnpm wp-start-upsert-pr');
        expect(text).toContain('pnpm wp-finish-upsert-pr');
        expect(text).toContain('wp-start-update    → wp-finish-update');
        expect(text).toContain('wp-start-upsert-pr → wp-finish-upsert-pr');
    });

    it('states that an open PR FORCES the upsert-pr pair, and why', () => {
        const text = guidance.whyPrForcesFlowB().join('\n');
        expect(text).toContain('MUST use the upsert-pr pair');
        expect(text).toContain('REWRITES this branch');
        expect(text).toContain('re-pointed');
    });

    it('never suggests running the update-only flow inside the PR-only block', () => {
        expect(guidance.prFlow().join('\n')).not.toContain('pnpm wp-start-update');
        expect(guidance.whyPrForcesFlowB().join('\n')).not.toContain('pnpm wp-start-update');
    });

    it('pairs finish commands back to their start', () => {
        expect(guidance.pairedStart('wp-finish-update')).toBe('wp-start-update');
        expect(guidance.pairedStart('wp-finish-upsert-pr')).toBe('wp-start-upsert-pr');
        // Unknown input is echoed, never guessed into one of the two.
        expect(guidance.pairedStart('wp-something-else')).toBe('wp-something-else');
    });

    it('offers read-only checks and says --ff-only is not one of them', () => {
        const text = guidance.readOnlyChecks().join('\n');
        expect(text).toContain('git merge-base --is-ancestor origin/main HEAD');
        expect(text).toContain('git rev-list --left-right --count origin/main...HEAD');
        expect(text).toContain('`git merge --ff-only` is NOT a look');
    });
});

// The drift this whole file exists to stop: messages and docs inventing command names that no bin
// answers to (`wp-update-start`, `wp-git-update`), which sends an AI chasing a command that errors.
// The bins are the source of truth — read them out of pr-gate's package.json, then scan every tracked
// .ts/.md for `wp-`-prefixed commands that are not among them.
describe('no doc or message names a wp-* command that does not exist', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

    function knownStartFinishBins(): Set<string> {
        const pkg = path.join(repoRoot, 'packages/tooling/pr-gate/package.json');
        // webpieces-disable no-any-unknown -- package.json shape is narrowed on the next line
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { bin?: Record<string, string> };
        const bins = Object.keys(parsed.bin ?? {})
            .filter((b: string): boolean => b.startsWith('wp-start-') || b.startsWith('wp-finish-'));
        // If this ever drops below the four flow bins, the scan below has stopped protecting anything.
        expect(bins.sort()).toEqual([
            'wp-finish-update', 'wp-finish-upsert-pr', 'wp-start-update', 'wp-start-upsert-pr',
        ]);
        return new Set(bins);
    }

    it('every wp-start-*/wp-finish-* token in tracked .ts/.md files is a real bin', () => {
        const known = knownStartFinishBins();
        const files = execFileSync('git', ['ls-files', '*.ts', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
            .split('\n')
            .filter((f: string): boolean => f !== '' && !f.endsWith('sync-flow-guidance.spec.ts'));

        const bad: string[] = [];
        for (const file of files) {
            const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
            lines.forEach((line: string, i: number): void => {
                // Also catch the inverted/legacy shapes that have actually been typed into docs before:
                // `wp-update-start`, `wp-upsert-pr-start`, `wp-git-update`.
                const matches = line.match(/\bwp-(?:start|finish)-[a-z0-9-]+|\bwp-(?:update|upsert-pr|git-update)\b(?:-start|-finish)?/g) ?? [];
                for (const token of matches) {
                    if (!known.has(token)) bad.push(`${file}:${i + 1}  ${token}`);
                }
            });
        }
        expect(bad).toEqual([]);
    });
});
