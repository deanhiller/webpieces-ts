import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BranchIdentity,
    CliExitError,
    GateTokenService,
    MainSyncStatus,
    MainSyncStatusService,
    RepoRootFinder,
    ReviewJsonService,
    specTempDirs,
} from '@webpieces/rules-config';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { GatedPrPublisher, PublishedPr } from '../workflow/gated-pr-publisher';
import { GitExec } from '../workflow/git-exec';
import { MergeState } from '../workflow/merge-state';
import { SquashSettingsEnforcer } from '../workflow/squash-settings-enforcer';
import { HumanPostedPr, HumanPostPrCommand } from './human-post-pr-command';
import { BuildCommand } from './build-command';

function asType<T>(value: object): T {
    return value as T;
}

const FORK = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function summaryJson(): string {
    return JSON.stringify({
        title: 'Post inspected change',
        agent: 'codex',
        model: 'test',
        riskScore: 8,
        riskLevel: 'green',
        summary: 'Fixes #1046\n\nPosts the inspected change.',
        violations: [],
        risks: [],
        filesToReview: [],
    });
}

class TestCommand extends HumanPostPrCommand {
    answers: string[];
    refs: HumanPostedPr[] = [
        new HumanPostedPr('', ''),
        new HumanPostedPr('42', 'https://example.test/pr/42'),
    ];
    fetches = 0;
    backfills = 0;
    editStatus = 0;
    onQuestion: ((question: string) => void) | null = null;

    constructor(answers: string[], deps: ConstructorParameters<typeof HumanPostPrCommand>) {
        super(...deps);
        this.answers = answers;
    }

    protected override question(question: string): Promise<string> {
        this.onQuestion?.(question);
        return Promise.resolve(this.answers.shift() ?? '');
    }
    protected override fetchMain(): void {
        this.fetches++;
    }
    protected override gateSalt(): string {
        return 'salt';
    }
    protected override git(args: string[]): string {
        return args[0] === 'merge-base' ? FORK : HEAD;
    }
    protected override resolvePr(): HumanPostedPr {
        return this.refs.shift() ?? new HumanPostedPr('42', 'https://example.test/pr/42');
    }
    protected override editPrBody(): number {
        this.backfills++;
        return this.editStatus;
    }
}

class Fixture {
    root = specTempDirs.make('human-post-pr-');
    review = new ReviewJsonService();
    cleanCalls = 0;
    publishCalls = 0;
    ensured = 0;
    builds = 0;
    status = new MainSyncStatus(
        'dean/feature',
        false,
        '',
        true,
        FORK,
        FORK,
        HEAD,
        false,
        [],
        'now',
    );
    mergeDir: string | null = null;
    markerValidated = true;

    deps(): ConstructorParameters<typeof HumanPostPrCommand> {
        return [
            asType<RepoRootFinder>({ resolveRepoRoot: (): string => this.root }),
            asType<BranchIdentity>({ current: (): string => 'dean/feature' }),
            new BranchNaming(),
            asType<AiBranchName>({ getFeatureName: (): string => 'dean-feature' }),
            asType<GitExec>({
                assertCleanTree: (): void => {
                    this.cleanCalls++;
                },
                runGitChecked: (): void => undefined,
            }),
            asType<MergeState>({
                mergeDirFor: (): string => this.root,
                findActiveMergeRunDir: (): string | null => this.mergeDir,
                readMergeMarker: (): object => ({ validated: this.markerValidated }),
            }),
            this.review,
            asType<MainSyncStatusService>({
                computeMainSyncStatus: (): MainSyncStatus => this.status,
            }),
            new GateTokenService(),
            asType<GatedPrPublisher>({
                publish: (): PublishedPr => {
                    this.publishCalls++;
                    return new PublishedPr('', false);
                },
            }),
            asType<SquashSettingsEnforcer>({
                ensure: (): void => {
                    this.ensured++;
                },
            }),
            asType<BuildCommand>({
                runStreaming: (): Promise<void> => {
                    this.builds++;
                    return Promise.resolve();
                },
            }),
        ];
    }

    summaryPath(): string {
        return this.review.summaryJsonPath(this.root, 'dean-feature');
    }
    writeSummary(body = summaryJson()): void {
        fs.mkdirSync(path.dirname(this.summaryPath()), { recursive: true });
        fs.writeFileSync(this.summaryPath(), body);
    }
    cleanup(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

const fixtures: Fixture[] = [];
function fixture(): Fixture {
    const f = new Fixture();
    fixtures.push(f);
    return f;
}
afterEach(() => {
    vi.restoreAllMocks();
    while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe('wp-human-post-pr attestation and preconditions', () => {
    for (const answer of ['AI', '', 'robot']) {
        it(`fails closed for ${JSON.stringify(answer)} before git/GitHub mutations`, async () => {
            const f = fixture();
            const command = new TestCommand([answer], f.deps());
            await expect(command.run()).rejects.toBeInstanceOf(CliExitError);
            expect(command.fetches).toBe(0);
            expect(f.cleanCalls).toBe(0);
            expect(f.publishCalls).toBe(0);
        });
    }

    it('refuses a dirty tree before fetch or publication', async () => {
        const f = fixture();
        const deps = f.deps();
        deps[4] = asType<GitExec>({
            assertCleanTree: (): never => {
                throw new CliExitError(1, 'dirty.txt');
            },
        });
        const command = new TestCommand(['human'], deps);
        await expect(command.run()).rejects.toThrow(/dirty\.txt/);
        expect(command.fetches).toBe(0);
        expect(f.publishCalls).toBe(0);
    });

    it('refuses an active unvalidated 3-point merge', async () => {
        const f = fixture();
        f.mergeDir = '/merge';
        f.markerValidated = false;
        const command = new TestCommand(['human', 'N'], f.deps());
        await expect(command.run()).rejects.toThrow(/unvalidated 3-point merge/);
        expect(f.publishCalls).toBe(0);
    });
});

describe('summary and freshness gates', () => {
    it('prints the exact path, canonical schema, and fork-point commands; N publishes nothing', async () => {
        const f = fixture();
        const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const command = new TestCommand(['human', 'N'], f.deps());
        await expect(command.run()).rejects.toThrow(/No PR was pushed or edited/);
        const text = out.mock.calls.map((call): string => String(call[0])).join('');
        expect(text).toContain(f.summaryPath());
        expect(text).toContain(`git diff ${FORK} HEAD`);
        expect(text).toContain(`git diff --name-only ${FORK} HEAD`);
        expect(text).toContain('"riskScore"');
        expect(f.publishCalls).toBe(0);
    });

    it('Y re-reads summary.json created while the prompt waits', async () => {
        const f = fixture();
        const command = new TestCommand(['human', 'Y', 'N'], f.deps());
        command.onQuestion = (question: string): void => {
            if (question.includes('continue?')) f.writeSummary();
        };
        await command.run();
        expect(f.publishCalls).toBe(1);
    });

    it('Y with a still-missing summary points back to wp-human-post-pr', async () => {
        const f = fixture();
        const command = new TestCommand(['human', 'Y'], f.deps());
        await expect(command.run()).rejects.toThrow(/Then re-run: pnpm wp-human-post-pr/);
        expect(f.publishCalls).toBe(0);
    });

    it('refuses a stale branch with conservative overlap and the PR-aware update flow', async () => {
        const f = fixture();
        f.writeSummary();
        f.status.originMain = 'c'.repeat(40);
        f.status.openPr = '17';
        f.status.conflictFiles = ['shared.ts'];
        const command = new TestCommand(['human', 'N'], f.deps());
        await expect(command.run()).rejects.toThrow(/wp-start-upsert-pr[\s\S]*shared\.ts/);
        expect(f.publishCalls).toBe(0);
    });
});

describe('successful human post', () => {
    it('mints the normal token, visibly marks the bypass, archives summary, and never merges', async () => {
        const f = fixture();
        f.writeSummary();
        const command = new TestCommand(['human', 'N'], f.deps());
        await command.run();
        expect(f.publishCalls).toBe(1);
        expect(f.ensured).toBe(1);
        expect(command.backfills).toBe(1);
        expect(fs.existsSync(f.summaryPath())).toBe(false);
        const body = fs.readFileSync(
            path.join(path.dirname(f.summaryPath()), 'pr-body.md'),
            'utf8',
        );
        expect(body).toContain('HUMAN ESCAPE HATCH');
        expect(body).toContain('cloud CI will run');
        expect(body).toContain('webpieces-pr-gate v1 token=');
    });

    it('runs wp-build and follows its log when the human answers Y', async () => {
        const f = fixture();
        f.writeSummary();
        const command = new TestCommand(['human', 'Y'], f.deps());
        await command.run();
        expect(f.builds).toBe(1);
        expect(f.cleanCalls).toBe(2);
        const body = fs.readFileSync(
            path.join(path.dirname(f.summaryPath()), 'pr-body.md'),
            'utf8',
        );
        expect(body).toContain('local wp-build passed');
    });

    it('fails with body-file and retry guidance when the final PR body edit fails', async () => {
        const f = fixture();
        f.writeSummary();
        const command = new TestCommand(['human', 'N'], f.deps());
        command.editStatus = 1;
        await expect(command.run()).rejects.toThrow(
            new RegExp(`${f.summaryPath().replace('summary.json', 'pr-body.md')}.*pnpm wp-human-post-pr`),
        );
        expect(fs.existsSync(f.summaryPath())).toBe(true);
    });

    it('asks the human the exact local-versus-cloud build question', async () => {
        const f = fixture();
        f.writeSummary();
        const questions: string[] = [];
        const command = new TestCommand(['human', 'N'], f.deps());
        command.onQuestion = (question: string): void => {
            questions.push(question.trim());
        };
        await command.run();
        expect(questions).toContain(
            'Run ' + 'wp-build here (If no, CI will run it in the cloud) Y/N?',
        );
        expect(f.builds).toBe(0);
    });
});
