import { checkoutLayout, specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { ARCHITECTURE_CONFLICT_HINT, MergeStart } from './merge-start';

/**
 * merge-START's conflict handback, from the shipped container with git SCRIPTED (#1381): the squash merge
 * conflicts, and the assertion is on what the AI is told. The generated architecture files get ONE short
 * line telling it to regenerate rather than hand-merge (#1429) — and only when one of them conflicted.
 */

const FORK = 'a'.repeat(40);
const FEATURE = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);

let repoRoot = '';
let home = '';
let feature: PrGateFeature;
let output: CapturedOutput | null = null;

beforeEach(async (): Promise<void> => {
    repoRoot = specTempDirs.make('wp-merge-start-');
    home = specTempDirs.make('wp-merge-start-home-');
    checkoutLayout.primary(repoRoot, 'dean/feat');
    vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    feature = await PrGateFeature.create();
});

afterEach((): void => {
    output?.stop();
    output = null;
    vi.restoreAllMocks();
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
});

/** Run merge-start to a conflict on `conflicted`, returning what it printed to stdout. */
const conflictOn = async (conflicted: string[]): Promise<string> => {
    const git = feature.git;
    git.respond(['branch', '--show-current'], git.ok('dean/feat\n'));
    git.respond(['status', '--porcelain'], git.ok(''));
    git.respond(['rev-parse', 'HEAD'], git.ok(`${FEATURE}\n`));
    git.respond(['rev-parse', 'origin/main'], git.ok(`${MAIN}\n`));
    git.respond(['merge-base', 'origin/main', 'HEAD'], git.ok(`${FORK}\n`));
    git.respondToPrefix(['show-ref'], git.fail(1));
    git.respond(['merge', '--squash', 'dean/feat'], git.fail(1, 'CONFLICT (content): Merge conflict'));
    git.respond(['diff', '--name-only', '--diff-filter=U'], git.ok(conflicted.join('\n') + '\n'));
    git.respondToPrefix([], git.ok());
    feature.processes.respondToPrefix('gh', ['pr', 'list'], feature.processes.ok('\n'));

    output = CapturedOutput.start();
    const result = await feature.container.get(MergeStart).mergeStart(repoRoot, 'wp-start-upsert-pr', home, 'wp-finish-upsert-pr');
    output.stop();
    expect(result.status).toBe('conflict');
    return output.stdout;
};

describe('merge-start conflict handback — the generated architecture files (#1429)', () => {
    it('tells the AI to regenerate, not hand-merge, when a generated architecture file conflicted', async (): Promise<void> => {
        const stdout = await conflictOn(['architecture/dependencies.json', 'packages/x/src/a.ts']);
        expect(stdout).toContain('  - architecture/dependencies.json\n');
        expect(stdout).toContain(
            "architecture/* conflicts: don't hand-merge — run pnpm nx run architecture:generate, then git add architecture/\n",
        );
        expect(stdout.split(ARCHITECTURE_CONFLICT_HINT)).toHaveLength(2);
    });

    it('says nothing about architecture/ when no generated architecture file conflicted', async (): Promise<void> => {
        const stdout = await conflictOn(['packages/x/src/a.ts', 'architecture/angular-di-analyzer-plan.md']);
        expect(stdout).toContain('  - packages/x/src/a.ts\n');
        expect(stdout).not.toContain('architecture:generate');
    });
});
