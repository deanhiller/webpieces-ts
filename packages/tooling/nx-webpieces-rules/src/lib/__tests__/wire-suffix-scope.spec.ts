import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { DiffScope, RuleFileExclusions } from '@webpieces/rules-config';
import { ModifiedCodeMode } from '@webpieces/rules-sdk';
import { WireSuffixScope } from '../api-usage/wire-suffix-scope';

let root = '';
const file = 'libraries/api/src/Types.ts';
const project = 'libraries/api';
const initial = 'export interface Legacy {\n    value: string;\n}\n';

beforeEach(() => {
    root = specTempDirs.makeReal('suffix-scope-');
    fs.mkdirSync(path.join(root, project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, file), initial);
    for (const args of [
        ['init', '-b', 'main'],
        ['config', 'user.name', 'Test'],
        ['config', 'user.email', 'test@example.com'],
        ['add', '.'],
        ['commit', '-m', 'base'],
    ]) {
        execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function scope(mode: ModifiedCodeMode, excludePaths: string[] = [], globalExcludes: string[] = []): WireSuffixScope {
    const exclusions = new RuleFileExclusions('required-type-suffix', globalExcludes, excludePaths);
    return new WireSuffixScope(root, mode, exclusions, new DiffScope());
}

function includes(policy: WireSuffixScope, name = 'Legacy', line = 1): boolean {
    return policy.includes(name, file, project, `${path.join(root, file)}:${line}:1`, [project]);
}

describe('wire suffix rollout uses the declaring type, independently of the doc rule', () => {
    it('grandfathers an untouched declaration and an edit to its fields in line mode', () => {
        expect(includes(scope('NEW_AND_MODIFIED_CODE'))).toBe(false);
        fs.writeFileSync(path.join(root, file), initial.replace('value: string', 'value: number'));
        expect(includes(scope('NEW_AND_MODIFIED_CODE'))).toBe(false);
        expect(includes(scope('NEW_AND_MODIFIED_FILES'))).toBe(true);
    });

    it('checks renamed and newly added declarations, including multiline name positions', () => {
        fs.writeFileSync(
            path.join(root, file),
            initial.replace('Legacy', 'Renamed') + 'export class\nFresh {}\n',
        );
        expect(includes(scope('NEW_AND_MODIFIED_CODE'), 'Renamed')).toBe(true);
        expect(includes(scope('NEW_AND_MODIFIED_CODE'), 'Fresh', 4)).toBe(true);
    });

    it('whole-project mode includes legacy types when only a README changes', () => {
        fs.writeFileSync(path.join(root, project, 'README.md'), 'Changed project');
        expect(includes(scope('NEW_AND_MODIFIED_CODE'))).toBe(false);
        expect(includes(scope('NEW_AND_MODIFIED_FILES'))).toBe(false);
        expect(includes(scope('MODIFIED_PROJECTS'))).toBe(true);
        expect(includes(scope('RUN_EVERY_TIME'))).toBe(true);
    });

    it('honors OFF and the framework-owned excludePaths (per-rule and top-level) even in whole-repo mode', () => {
        expect(includes(scope('OFF'))).toBe(false);
        expect(includes(scope('RUN_EVERY_TIME', ['libraries/api/**']))).toBe(false);
        expect(includes(scope('RUN_EVERY_TIME', [], ['libraries/api/**']))).toBe(false);
    });

    it('does not mark a parent project touched by edits owned by a nested project', () => {
        fs.mkdirSync(path.join(root, project, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(root, project, 'nested/README.md'), 'Nested project edit');
        expect(
            scope('MODIFIED_PROJECTS').includes(
                'Legacy',
                file,
                project,
                `${path.join(root, file)}:1:1`,
                [project, `${project}/nested`],
            ),
        ).toBe(false);
    });

    it.each([
        '// webpieces-disable required-type-suffix -- published schema name\n' + initial,
        initial.replace(
            'Legacy {',
            'Legacy { // webpieces-disable required-type-suffix -- published schema name',
        ),
    ])('honors a per-site disable on or above the name line', (text: string) => {
        fs.writeFileSync(path.join(root, file), text);
        expect(includes(scope('RUN_EVERY_TIME'), 'Legacy', text.startsWith('//') ? 2 : 1)).toBe(
            false,
        );
    });
});
