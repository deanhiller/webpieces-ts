import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrate } from '../../bin/setup-config';
import { run } from '../runner';
import { BlockedResult, NormalizedEdit, NormalizedToolInput } from '../types';

function gitIn(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function rulesConfig(validateMode: 'OFF' | 'NEW_AND_MODIFIED_FILES'): Record<string, unknown> {
    // webpieces-disable no-any-unknown -- migrate returns the complete validated config; the test only flips known rule modes
    const config = migrate({}).config as Record<string, any>;
    config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
    for (const name of Object.keys(config.hookGuards)) config.hookGuards[name].mode = 'OFF';
    for (const name of Object.keys(config.rules)) config.rules[name].mode = 'OFF';
    config.rules['validate-ts-in-src'].mode = validateMode;
    return config;
}

function writeConfig(root: string, mode: 'OFF' | 'NEW_AND_MODIFIED_FILES'): void {
    fs.writeFileSync(path.join(root, 'webpieces.config.json'), JSON.stringify(rulesConfig(mode)));
}

function writeTarget(filePath: string): NormalizedToolInput {
    return new NormalizedToolInput(filePath, [new NormalizedEdit('', 'export const value = 1;\n')]);
}

describe('validate-ts-in-src — target tree identity for linked-worktree writes', () => {
    let sandbox = '';
    let primary = '';
    let sibling = '';
    let nested = '';

    beforeAll(() => {
        sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ts-worktree-')));
        primary = path.join(sandbox, 'primary');
        sibling = path.join(sandbox, 'wt-sibling');
        nested = path.join(primary, '.claude', 'worktrees', 'agent-898');

        fs.mkdirSync(path.join(primary, 'services', 'app', 'src'), { recursive: true });
        fs.writeFileSync(path.join(primary, 'services', 'app', 'project.json'), JSON.stringify({
            name: 'app',
            sourceRoot: 'services/app/src',
        }));
        fs.writeFileSync(path.join(primary, 'services', 'app', 'src', 'seed.ts'), 'export {};\n');
        writeConfig(primary, 'NEW_AND_MODIFIED_FILES');

        gitIn(primary, 'init', '-b', 'main');
        gitIn(primary, 'config', 'core.hooksPath', '/dev/null');
        gitIn(primary, 'config', 'user.email', 'test@example.com');
        gitIn(primary, 'config', 'user.name', 'test');
        gitIn(primary, 'add', '-A');
        gitIn(primary, 'commit', '-m', 'init');
        gitIn(primary, 'worktree', 'add', '-b', 'sibling-test', sibling);
        gitIn(primary, 'worktree', 'add', '-b', 'nested-test', nested);

        // A target worktree's local policy must not take over: the session/governed checkout owns
        // configuration, while the target checkout owns file/project topology.
        writeConfig(sibling, 'OFF');
        writeConfig(nested, 'OFF');
    });

    afterAll(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

    it('allows a new TypeScript source file in a sibling linked worktree project', () => {
        const target = path.join(sibling, 'services', 'app', 'src', 'new-service.ts');
        expect(run('Write', writeTarget(target), primary, 'rules')).toBeNull();
    });

    it('allows a new TypeScript spec in a nested .claude/worktrees checkout', () => {
        const target = path.join(nested, 'services', 'app', 'src', 'new-service.spec.ts');
        expect(run('Write', writeTarget(target), primary, 'rules')).toBeNull();
    });

    it('still rejects a worktree project file outside src', () => {
        const target = path.join(sibling, 'services', 'app', 'scripts', 'generate.ts');
        const result = run('Write', writeTarget(target), primary, 'rules') as BlockedResult;
        expect(result).toBeInstanceOf(BlockedResult);
        expect(result.report).toContain('inside project `services/app` but outside its src/ directory');
    });

    it('still rejects a truly projectless worktree TypeScript file', () => {
        const target = path.join(nested, 'misc', 'orphan.ts');
        const result = run('Write', writeTarget(target), primary, 'rules') as BlockedResult;
        expect(result).toBeInstanceOf(BlockedResult);
        expect(result.report).toContain('File is not inside any Nx project');
    });

    it('keeps policy rooted in the governed checkout even when target-worktree policy is OFF', () => {
        const target = path.join(sibling, 'services', 'app', 'outside-src.ts');
        expect(run('Write', writeTarget(target), primary, 'rules')).toBeInstanceOf(BlockedResult);
    });
});
