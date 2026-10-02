import 'reflect-metadata';
import { Container } from 'inversify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoRootFinder } from '@webpieces/rules-config';

import { PrGateApp } from './pr-gate-app';
import { BuildAffected } from './workflow/build-affected';
import { PrGateCliApp } from './pr-gate-cli-app';
import {
    PrGateCliExit,
    PrGateCliInvocation,
    PrGateCliOutput,
    PrGateCliStdin,
} from './pr-gate-cli-invocation';

class CannedStdin extends PrGateCliStdin {
    constructor(private readonly bytes: string = '{"status":"green"}') {
        super();
    }
    override read(): string {
        return this.bytes;
    }
}

class CapturedOutput extends PrGateCliOutput {
    bytes: string = '';
    override write(bytes: string): void {
        this.bytes += bytes;
    }
}

class RecordedExit extends PrGateCliExit {
    code: number | null = null;
    override exit(code: number): void {
        this.code = code;
    }
}

class RunResult {
    constructor(
        readonly stdout: CapturedOutput,
        readonly stderr: CapturedOutput,
        readonly exit: RecordedExit,
    ) {}
}

class CliFeatureDriver {
    async run(
        binName: string,
        argv: string[] = [],
        stdin: string = '{"status":"green"}',
    ): Promise<RunResult> {
        const stdout = new CapturedOutput();
        const stderr = new CapturedOutput();
        const exit = new RecordedExit();
        const container = new Container({ autobind: true });
        await container
            .get(PrGateCliApp)
            .run(
                new PrGateCliInvocation(
                    binName,
                    argv,
                    '/fixture/repo',
                    new CannedStdin(stdin),
                    stdout,
                    stderr,
                    exit,
                ),
            );
        return new RunResult(stdout, stderr, exit);
    }
}

const driver = new CliFeatureDriver();

afterEach(() => vi.restoreAllMocks());

describe('PrGateCliApp — published command boundary', () => {
    const noArgCommands = [
        ['wp-finish-upsert-pr', 'finishUpsertPr'],
        ['wp-human-post-pr', 'humanPostPr'],
        ['wp-upsert-hotfix-pr', 'upsertHotfixPr'],
        ['wp-start-upsert-pr', 'startUpsertPr'],
        ['wp-start-update', 'startUpdate'],
        ['wp-finish-update', 'finishUpdate'],
        ['wp-sync-main', 'syncMain'],
        ['wp-check-pr', 'checkPr'],
        ['wp-review-upsert-pr', 'reviewUpsertPr'],
        ['wp-await-reviews', 'awaitReviews'],
    ] as const;

    it.each(noArgCommands)(
        'routes %s through the real container to PrGateApp.%s',
        async (binName: string, method: keyof PrGateApp): Promise<void> => {
            const call = vi.spyOn(PrGateApp.prototype, method).mockResolvedValue(undefined);
            const result = await driver.run(binName);
            expect(call).toHaveBeenCalledOnce();
            expect(result.exit.code).toBeNull();
        },
    );

    it('parses wp-build --force', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'build').mockResolvedValue(undefined);
        await driver.run('wp-build', ['--force']);
        expect(call.mock.calls[0][0].force).toBe(true);
    });

    it('drives wp-build through the real application and replaces only the build-process boundary', async (): Promise<void> => {
        vi.spyOn(RepoRootFinder.prototype, 'resolveRepoRoot').mockReturnValue('/fixture/repo');
        const build = vi
            .spyOn(BuildAffected.prototype, 'runBuildGate')
            .mockResolvedValue(undefined);

        const result = await driver.run('wp-build', ['--force']);

        expect(build).toHaveBeenCalledOnce();
        expect(build.mock.calls[0][0]).toBe('/fixture/repo');
        expect(build.mock.calls[0][1]).toMatchObject({
            rerunCommand: 'pnpm wp-build',
            stage: 'build',
        });
        expect(result.exit.code).toBeNull();
    });

    it('parses cleanup selections without touching process argv', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'cleanup').mockResolvedValue(undefined);
        await driver.run('wp-cleanup', [
            '--report',
            '--delete-branches=1,3',
            '--delete-worktrees=none',
        ]);
        const options = call.mock.calls[0][0];
        expect(options.report).toBe(true);
        expect(options.branches.numbers).toEqual([1, 3]);
        expect(options.worktrees.mode).toBe('none');
    });

    it('parses wp-land-pr --pr', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'landPr').mockResolvedValue(undefined);
        await driver.run('wp-land-pr', ['--pr', '123']);
        expect(call.mock.calls[0][0].prNumber).toBe('123');
    });

    it('parses every wp-push-dev flag', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'pushDev').mockResolvedValue(undefined);
        await driver.run('wp-push-dev', [
            '--list',
            '--remove',
            '--force',
            '--rebase-resolution',
            '--resolve',
            'dean/x',
        ]);
        expect(call.mock.calls[0][0]).toMatchObject({
            list: true,
            remove: true,
            force: true,
            rebaseResolution: true,
            resolve: true,
            resolveTarget: 'dean/x',
        });
    });

    it('parses wp-finish-push-dev --abort', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'finishPushDev').mockResolvedValue(undefined);
        await driver.run('wp-finish-push-dev', ['--abort']);
        expect(call.mock.calls[0][0].abort).toBe(true);
    });

    it('parses wp-await-checks --pr', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'awaitChecks').mockResolvedValue(undefined);
        await driver.run('wp-await-checks', ['--pr', '456']);
        expect(call.mock.calls[0][0].prNumber).toBe('456');
    });

    it('passes injected stdin and cwd to wp-write-review', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'writeReview').mockResolvedValue(undefined);
        await driver.run('wp-write-review', ['--checklist', 'required'], '{"id":"required"}');
        expect(call.mock.calls[0][0]).toMatchObject({
            checklistId: 'required',
            json: '{"id":"required"}',
            cwd: '/fixture/repo',
        });
    });

    it('passes injected stdin and cwd to wp-write-review-fixes', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'writeReviewFixes').mockResolvedValue(undefined);
        await driver.run('wp-write-review-fixes', [], '{"fixes":[]}');
        expect(call.mock.calls[0][0]).toMatchObject({ json: '{"fixes":[]}', cwd: '/fixture/repo' });
    });

    it('renders help to stdout and exits zero before dispatch', async (): Promise<void> => {
        const call = vi.spyOn(PrGateApp.prototype, 'startUpdate').mockResolvedValue(undefined);
        const result = await driver.run('/installed/bin/wp-start-update', ['--help']);
        expect(call).not.toHaveBeenCalled();
        expect(result.stdout.bytes).toContain('Usage:  pnpm wp-start-update');
        expect(result.exit.code).toBe(0);
    });

    it('renders unknown commands to stderr with exit two', async (): Promise<void> => {
        const result = await driver.run('wp-does-not-exist');
        expect(result.stderr.bytes).toContain('Unknown PR-gate command');
        expect(result.exit.code).toBe(2);
    });
});
