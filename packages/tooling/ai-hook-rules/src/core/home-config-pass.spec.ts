import { describe, it, expect, beforeAll } from 'vitest';
import * as os from 'os';
import * as nodePath from 'path';
import { GoldenRepoBuilder, GOLDEN_FIXTURES } from '../adapters/hook-app-fixtures';
import { NormalizedToolInput, NormalizedEdit, BlockedResult } from '@webpieces/hook-runtime';
import { run } from './runner';
describe('run — the ~/.webpieces/config.json carve-out', () => {
    // `axios` trips the shipped no-fetch match-rule, so this content is provably judged somewhere.
    const offending = 'const { a } = b;\n';
    let homeRoot = '';

    beforeAll(() => {
        homeRoot = new GoldenRepoBuilder().build(GOLDEN_FIXTURES[0]).repo;
    });

    it('passes a Write to ~/.webpieces/config.json unconditionally', () => {
        const home = nodePath.join(os.homedir(), '.webpieces', 'config.json');
        const input = new NormalizedToolInput(home, [new NormalizedEdit('', offending, false)]);
        expect(run('Write', input, homeRoot, 'rules')).toBeNull();
    });

    it('CONTROL — the same content at an ordinary path is still judged', () => {
        const input = new NormalizedToolInput(nodePath.join(homeRoot, 'src', 'x.ts'), [new NormalizedEdit('', offending, false)]);
        expect(run('Write', input, homeRoot, 'rules')).toBeInstanceOf(BlockedResult);
    });
});
