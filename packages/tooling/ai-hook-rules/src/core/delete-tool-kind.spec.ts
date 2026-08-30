import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import { migrate } from '../bin/setup';
import { run } from './runner';
import { BlockedResult, NormalizedToolInput, NormalizedEdit } from './types';

/**
 * `ToolKind` gained 'Delete' for Codex's `*** Delete File:` directive, and EVERY existing rule defaults
 * to NOT firing on it (DELETE_SCOPED_RULES in runner.ts is empty).
 *
 * The CONTROL case is what makes this non-vacuous: the identical path, judged as a Write, IS blocked.
 * So a green here means "the rules are off for Delete", not "the rules were never on".
 */
let root = '';

function gitIn(dir: string, ...args: readonly string[]): void {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp-delete-kind-')));
    fs.mkdirSync(root, { recursive: true });
    gitIn(root, 'init', '-b', 'main');
    // Temp repos must not run this machine's global hooks.
    gitIn(root, 'config', 'core.hooksPath', '/dev/null');
    gitIn(root, 'config', 'user.email', 'test@example.com');
    gitIn(root, 'config', 'user.name', 'test');
    fs.writeFileSync(nodePath.join(root, 'f.txt'), 'x');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-m', 'init');

    // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
    const config = migrate({}).config as Record<string, any>;
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) config.hookGuards[name].mode = 'OFF';
    fs.writeFileSync(nodePath.join(root, 'webpieces.config.json'), JSON.stringify(config));
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('ToolKind Delete', () => {
    // `axios` trips the shipped no-fetch match-rule — provably judged content.
    const offending = 'import axios from "axios";\n';

    it('CONTROL — the content IS blocked when the same path is written', () => {
        const input = new NormalizedToolInput(nodePath.join(root, 'src', 'x.ts'), [new NormalizedEdit('', offending)]);
        expect(run('Write', input, root, 'rules')).toBeInstanceOf(BlockedResult);
    });

    it('no rule fires on a Delete of that same path', () => {
        const input = new NormalizedToolInput(nodePath.join(root, 'src', 'x.ts'), [new NormalizedEdit('', offending)]);
        expect(run('Delete', input, root, 'rules')).toBeNull();
    });

    it('no rule fires on a Delete carrying no edits at all — the shape the patch parser produces', () => {
        const input = new NormalizedToolInput(nodePath.join(root, 'src', 'x.ts'), []);
        expect(run('Delete', input, root, 'rules')).toBeNull();
        expect(run('Delete', input, root, 'guards')).toBeNull();
        expect(run('Delete', input, root, 'all')).toBeNull();
    });
});
