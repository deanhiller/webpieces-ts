import 'reflect-metadata';
import { checkoutLayout, specTempDirs } from '@webpieces/tooling-testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BuildsLog, BuildTicket, BuildTermination } from '@webpieces/rules-config';
import { DotWebpieces, GitResultDto } from '@webpieces/tooling-common';

import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { RepoConfigFixture } from '../workflow/repo-config-testkit';
import { REVIEW_CONSOLE_LOG, FINISH_CONSOLE_LOG } from '../workflow/stage-output-log';
import { BuildCommand, BuildOptions } from './build-command';
import { ReviewUpsertPrCommand } from './review-upsert-pr-command';
import { FinishUpsertPrCommand } from './finish-upsert-pr-command';

/**
 * Issue #1393, as the user of these commands meets it: an unattended agent in a LINKED WORKTREE runs
 * `wp-build`, `wp-review-upsert-pr` or `wp-finish-upsert-pr` — often in the background — and needs to know
 * where the log is BEFORE the command finishes, at a path inside the worktree it is confined to.
 *
 * Each case drives the shipped container's command with only the edges scripted (git, the build shell,
 * the machine-wide build ledger's HOME), and asserts on what LEFT the program: its first stdout line, and
 * the file that line names — which must already exist while the command is still running.
 */
const BUILD = 'pnpm fake-build';

let tmp = '';
let primary = '';
let worktree = '';
let feature: PrGateFeature;
let output: CapturedOutput | null = null;

/** The REAL ledger, pointed at a throwaway HOME so the suite never appends to the developer's own. */
class TempHomeBuildsLog extends BuildsLog {
    constructor(private readonly home: string) {
        super(new DotWebpieces());
    }

    override start(by: string, startDir: string): BuildTicket {
        return super.start(by, startDir, this.home);
    }

    override finish(ticket: BuildTicket, termination: BuildTermination): void {
        super.finish(ticket, termination, this.home);
    }
}

beforeEach(async () => {
    tmp = specTempDirs.makeReal('wp-fulllog-');
    primary = path.join(tmp, 'primary');
    worktree = path.join(tmp, 'wt-feature');
    fs.mkdirSync(primary, { recursive: true });
    checkoutLayout.primaryWithWorktree(primary, worktree, 'dean/feature');

    // THIS repo's own config, so the real validator and the real build-command resolver are what run.
    const fixture = new RepoConfigFixture();
    const config = fixture.load();
    // webpieces-disable no-any-unknown -- narrowing one nested section of the opaque config document
    const commands = config['commands'] as Record<string, Record<string, unknown>>;
    commands['pr-gate']['buildCommand'] = BUILD;
    fixture.writeTo(worktree, config);

    feature = await PrGateFeature.create();
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    (await feature.container.rebind(BuildsLog)).toConstantValue(new TempHomeBuildsLog(home));
    feature.git.respond(['-C', worktree, 'rev-parse', '--short', 'HEAD'], feature.git.ok('abc1234\n'));
    // The agent is standing in its worktree.
    vi.spyOn(process, 'cwd').mockReturnValue(worktree);
});

afterEach(() => {
    if (output !== null) output.stop();
    output = null;
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
});

function firstLine(text: string): string {
    return text.split('\n')[0];
}

/** Where every log a command points its caller at must land: inside the worktree it ran in. */
function inWorktreeLog(name: string): string {
    return path.join(worktree, '.webpieces', 'logs', name);
}

describe('wp-build names its FullLog first, inside the worktree (issue #1393)', () => {
    it('prints FullLog as the FIRST stdout line, and that file exists while the build runs', async () => {
        const expected = inWorktreeLog('build.log');
        let firstLineWhileRunning = '';
        let existedWhileRunning = false;
        feature.processes.respondToShell(BUILD, () => {
            firstLineWhileRunning = firstLine(output?.stdout ?? '');
            existedWhileRunning = fs.existsSync(expected);
            return feature.processes.exited(0, 'compiled\n');
        });

        output = CapturedOutput.start();
        await feature.container.get(BuildCommand).run(new BuildOptions(true));
        output.stop();

        expect(firstLineWhileRunning).toBe(`FullLog : ${expected}`);
        expect(existedWhileRunning).toBe(true);
        expect(fs.readFileSync(expected, 'utf8')).toContain('compiled');
        // …and again at the end, exactly as before.
        expect(output.stdout.trimEnd().split('\n')).toContain(`FullLog : ${expected}`);
        expect(output.stdout.indexOf(`FullLog : ${expected}`)).not.toBe(output.stdout.lastIndexOf(`FullLog : ${expected}`));
        // Nothing lands in the primary clone's worktree namespace, which a confined agent may not read.
        expect(fs.existsSync(path.join(primary, '.webpieces', 'worktrees', 'wt-feature', 'logs', 'build.log'))).toBe(false);
    });
});

/**
 * The two PR stages open with the path of their own console log. Each run here fails at its first git
 * question — the git edge is scripted to refuse — because what is under test is what the stage printed
 * BEFORE any work, and that the file it named was already there while the stage was working.
 */
describe.each([
    ['wp-review-upsert-pr', REVIEW_CONSOLE_LOG, (): Promise<void> => feature.container.get(ReviewUpsertPrCommand).run()],
    ['wp-finish-upsert-pr', FINISH_CONSOLE_LOG, (): Promise<void> => feature.container.get(FinishUpsertPrCommand).run()],
])('%s names its FullLog first, inside the worktree (issue #1393)', (_name: string, logName: string, run: () => Promise<void>) => {
    it('prints FullLog as the FIRST stdout line, and that file exists while the stage runs', async () => {
        const expected = inWorktreeLog(logName);
        let existedWhileRunning = false;
        feature.git.respondToPrefix([], (): GitResultDto => {
            existedWhileRunning = fs.existsSync(expected);
            return feature.git.fail(128, 'scripted: stop the stage here');
        });

        output = CapturedOutput.start();
        await expect(run()).rejects.toBeDefined();
        output.stop();

        expect(firstLine(output.stdout)).toBe(`FullLog : ${expected}`);
        expect(existedWhileRunning).toBe(true);
        expect(fs.existsSync(path.join(primary, '.webpieces', 'worktrees', 'wt-feature', 'logs', logName))).toBe(false);
    });
});
