import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #1273 deleted the committed rule lock and the command that regenerated it. Their only remaining job was
 * to fail every upgrade that changed no rule, so nothing in `packages/**` — code, spec, template, README —
 * may name either one again. The needles are assembled so this file does not match itself.
 */
const NEEDLES: readonly string[] = [['rules', 'lock'].join('.'), ['wp', 'rules', 'sync'].join('-')];

describe('the rule lock and its sync command are gone from packages/** (#1273)', () => {
    it('no tracked or new file under packages/ names them', () => {
        const repo = path.resolve(__dirname, '../../../..');
        const files = execFileSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages'],
            { cwd: repo, encoding: 'utf8' },
        )
            .split('\n')
            .filter((file: string) => file !== '' && fs.existsSync(path.join(repo, file)));
        expect(files.length).toBeGreaterThan(100);
        const offenders = files.filter((file: string) => {
            const text = fs.readFileSync(path.join(repo, file), 'utf8');
            return NEEDLES.some((needle: string) => text.includes(needle));
        });
        expect(offenders).toEqual([]);
    });
});
