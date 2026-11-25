import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkoutLayout } from '@webpieces/tooling-testkit';
import { RepoConfigFixture } from '../workflow/repo-config-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { PrGateFeature, CapturedOutput } from '../../__tests__/feature-harness';
import { PrGateApp } from '../pr-gate-app';
import { RecoverReviewOptions } from './recover-review-command';
import { PrGateCliApp } from '../pr-gate-cli-app';
import {
    PrGateCliInvocation,
    PrGateCliStdin,
    PrGateCliOutput,
    PrGateCliExit,
} from '../pr-gate-cli-invocation';

const HEAD = 'b'.repeat(40);
const PUBLISHED = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const PATCH =
    'diff --git a/feature.ts b/feature.ts\n--- a/feature.ts\n+++ b/feature.ts\n@@ -1 +1 @@\n-old\n+new\n';
const SCOPE = '7a071cb1f77693354d3070442a9232d37f3f0222b3d025d6ab2901332f16de84';
const SLUG = 'dean-feature';
const URL = 'https://github.com/example/repo/pull/42';

class RecoveryTestInput extends PrGateCliStdin {
    override read(): string {
        return '';
    }
}
class RecoveryTestOutput extends PrGateCliOutput {
    bytes = '';
    override write(bytes: string): void {
        this.bytes += bytes;
    }
}
class RecoveryTestExit extends PrGateCliExit {
    code = 0;
    override exit(code: number): void {
        this.code = code;
    }
}
class RecoveryCliResult {
    constructor(
        readonly code: number,
        readonly error: string,
        readonly output: string,
    ) {}
}

class RecoveryFixture {
    branch = 'dean/featureSquash';
    readonly root = specTempDirs.make('wp-recovery-destination-');
    readonly source = path.join(specTempDirs.make('wp-recovery-source-'), SLUG);
    readonly destination = path.join(this.root, '.webpieces/pr-review', SLUG);
    constructor(readonly feature: PrGateFeature) {
        fs.mkdirSync(this.source, { recursive: true });
        fs.writeFileSync(path.join(this.root, 'webpieces.config.json'), '{}');
        fs.writeFileSync(path.join(this.source, 'pr-body.md'), URL + '\n');
        this.write('review-stage.json', {
            headSha: HEAD,
            buildHeadSha: HEAD,
            buildPassedAt: '2026-01-01',
            mergeValidated: true,
            buildCommand: 'pnpm build',
            reviewersBriefed: ['security', 'requirements'],
            optionalBriefed: [],
            scopeHashes: { security: SCOPE, requirements: SCOPE },
            round: 1,
            maxReviewerRounds: 1,
        });
        this.write('stages/stage3-finish.json', { head: PUBLISHED });
        this.verdict('security', 'green');
        this.verdict('requirements', 'orange');
        this.write('review-round1-fixes.json', {
            fromHead: HEAD,
            toHead: PUBLISHED,
            responses: [
                {
                    checklistId: 'requirements',
                    resolution: 'Added missing regression',
                    files: ['feature.ts'],
                },
            ],
        });
        this.gitEvidence();
        this.evidence();
        feature.processes.respond(
            'gh',
            ['pr', 'view', '42', '--json', 'url,headRefName,headRefOid,state'],
            feature.processes.ok(
                JSON.stringify({
                    url: URL,
                    headRefName: 'dean/feature',
                    headRefOid: PUBLISHED,
                    state: 'OPEN',
                }),
            ),
        );
    }
    private gitEvidence(): void {
        const feature = this.feature;
        feature.git.respond(
            ['branch', '--show-current'],
            (): ReturnType<typeof feature.git.ok> => feature.git.ok(this.branch),
        );
        feature.git.respondToPrefix(['merge-base', '--is-ancestor'], (call) =>
            call.args.includes('f'.repeat(40)) ? feature.git.fail(1) : feature.git.ok(),
        );
        feature.git.respondToPrefix(
            ['show'],
            feature.git.ok(
                JSON.stringify({
                    commands: {
                        'pr-gate': {
                            checklists: [
                                { id: 'security', patterns: ['**'], required: true },
                                { id: 'requirements', patterns: ['**'], required: true },
                            ],
                        },
                    },
                }),
            ),
        );
        feature.git.respondToPrefix(['diff', BASE], (call) =>
            feature.git.ok(
                call.args.includes('--name-only') ? 'feature.ts\n' : this.patch(call.args[2]),
            ),
        );
    }
    patch(head: string): string {
        return head === HEAD ? PATCH : PATCH.replace('+new', '+author-fixed');
    }
    evidence(head = HEAD): void {
        const body = this.patch(head);
        this.write('stages/stage2-review.json', {
            head,
            base: BASE,
            dirty: false,
            changedFiles: ['feature.ts'],
        });
        this.write('pr-context.json', {
            head,
            base: BASE,
            dirty: false,
            changedFiles: ['feature.ts'],
        });
        const relative = `.webpieces/pr-review/${SLUG}/diff/files/feature.ts.diff`;
        this.write('diff/manifest.json', {
            base: BASE,
            head,
            hashForkPoint: BASE,
            hashFeatureHead: head,
            dirty: false,
            entries: [
                {
                    file: 'feature.ts',
                    diffFile: relative,
                    status: 'M',
                    bytes: body.length,
                    truncated: false,
                },
            ],
            excluded: [],
            omittedFromAllDiff: [],
            allDiffBytes: body.length,
            allDiffLines: body.split('\n').length,
        });
        fs.mkdirSync(path.join(this.source, 'diff/files'), { recursive: true });
        fs.writeFileSync(path.join(this.source, 'diff/files/feature.ts.diff'), body);
        fs.writeFileSync(path.join(this.source, 'diff/ALL.diff'), body);
        fs.mkdirSync(path.join(this.source, 'instructions'), { recursive: true });
        for (const id of ['security', 'requirements'])
            fs.writeFileSync(
                path.join(this.source, `instructions/${id}.instructions.md`),
                `# Checklist \`${id}\`\nGlobal reviewer round 1 of 1.\nfork point (A) ${BASE}\nfeature head (B) ${head}\n${relative.replace('files/feature.ts.diff', 'manifest.json')}\n| \`feature.ts\` | \`M\` | diff | full source |\n`,
            );
    }
    write(name: string, value: object): void {
        fs.mkdirSync(path.dirname(path.join(this.source, name)), { recursive: true });
        fs.writeFileSync(path.join(this.source, name), JSON.stringify(value, null, 2) + '\n');
    }
    private verdict(id: string, status: string): void {
        const fields = [id, status, 'codex', 'test', 'Verified original change'];
        this.write(`review-round1-${id}.json`, {
            id,
            status,
            agent: 'codex',
            model: 'test',
            output: fields[4],
        });
        this.write(`review-round1-${id}.provenance.json`, {
            writer: 'wp-write-review',
            checklistId: id,
            round: 1,
            status,
            harness: 'codex',
            agentId: 'original-agent',
            sessionId: 'original-session',
            headSha: HEAD,
            scopeHash: SCOPE,
            verdictHash: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
        });
    }
    async cli(): Promise<RecoveryCliResult> {
        const error = new RecoveryTestOutput();
        const exit = new RecoveryTestExit();
        const captured = CapturedOutput.start();
        try {
            await this.feature.container
                .get(PrGateCliApp)
                .run(
                    new PrGateCliInvocation(
                        'wp-recover-review',
                        ['--from', this.source, '--pr', '42'],
                        this.root,
                        new RecoveryTestInput(),
                        new RecoveryTestOutput(),
                        error,
                        exit,
                    ),
                );
            return new RecoveryCliResult(exit.code, error.bytes, captured.stdout);
        } finally {
            captured.stop();
        }
    }
    async run(apply = true): Promise<string> {
        const output = CapturedOutput.start();
        try {
            await this.feature.container
                .get(PrGateApp)
                .recoverReview(new RecoverReviewOptions(this.source, '42', apply, this.root));
            return output.stdout;
        } finally {
            output.stop();
        }
    }
}
async function fixture(): Promise<RecoveryFixture> {
    return new RecoveryFixture(await PrGateFeature.create());
}

describe('recover an existing published review through the shipped program', () => {
    it('preserves original final-round verdict/provenance/fixes and requires a fresh build', async () => {
        const f = await fixture();
        fs.mkdirSync(f.destination, { recursive: true });
        fs.writeFileSync(path.join(f.destination, 'summary.json'), 'current summary');
        fs.writeFileSync(path.join(f.destination, 'pr-context.json'), 'current source context');
        const output = await f.run();
        for (const name of [
            'review-round1-security.json',
            'review-round1-security.provenance.json',
            'review-round1-requirements.json',
            'review-round1-fixes.json',
        ])
            expect(fs.readFileSync(path.join(f.destination, name))).toEqual(
                fs.readFileSync(path.join(f.source, name)),
            );
        const receipt = JSON.parse(
            fs.readFileSync(path.join(f.destination, 'review-stage.json'), 'utf8'),
        );
        expect(receipt).toMatchObject({
            headSha: HEAD,
            round: 1,
            maxReviewerRounds: 1,
            reviewersBriefed: ['security', 'requirements'],
            buildHeadSha: '',
            buildPassedAt: '',
            mergeValidated: false,
        });
        expect(
            fs.readFileSync(path.join(f.destination, 'recovered-original-review-stage.json')),
        ).toEqual(fs.readFileSync(path.join(f.source, 'review-stage.json')));
        expect(fs.readFileSync(path.join(f.destination, 'summary.json'), 'utf8')).toBe(
            'current summary',
        );
        expect(fs.readFileSync(path.join(f.destination, 'pr-context.json'), 'utf8')).toBe(
            'current source context',
        );
        expect(
            fs.readFileSync(path.join(f.destination, 'recovered-original-state/pr-context.json')),
        ).toEqual(fs.readFileSync(path.join(f.source, 'pr-context.json')));
        expect(output).toContain('Fresh normal pnpm wp-review-upsert-pr build REQUIRED');
        expect(f.feature.processes.commandLines()).toHaveLength(1);
    });
    it('the normal review stage builds current source and carries the frozen final round without re-briefing', async () => {
        const f = await fixture();
        const configFixture = new RepoConfigFixture();
        const config = configFixture.load();
        const gate = (config['commands'] as Record<string, Record<string, unknown>>)['pr-gate'];
        gate['buildCommand'] = 'echo mocked-fresh-build';
        gate['maxReviewerRounds'] = 1;
        gate['reviewerAgents'] = 1;
        gate['checklists'] = ['security', 'requirements', 'later-checklist'].map((id) => ({
            id,
            required: true,
            doc: `checklists/${id}.md`,
            patterns: ['**'],
        }));
        for (const id of ['security', 'requirements', 'later-checklist']) {
            fs.mkdirSync(path.join(f.root, 'checklists'), { recursive: true });
            fs.writeFileSync(path.join(f.root, 'checklists', `${id}.md`), 'Inspect the change');
        }
        configFixture.writeTo(f.root, config);
        checkoutLayout.primary(f.root, 'dean/featureSquash');
        await f.run();
        const git = f.feature.git;
        git.respond(['status', '--porcelain'], git.ok());
        git.respond(['status', '--porcelain', '--untracked-files=all'], git.ok());
        git.respond(['rev-parse', 'HEAD'], git.ok('e'.repeat(40)));
        git.respond(['rev-parse', 'origin/main'], git.ok('a'.repeat(40)));
        git.respond(['merge-base', 'origin/main', 'HEAD'], git.ok('a'.repeat(40)));
        git.respondToPrefix(['diff'], (call) =>
            git.ok(
                call.args.includes('--name-only')
                    ? 'feature.ts\n'
                    : 'diff --git a/feature.ts b/feature.ts\n+changed\n',
            ),
        );
        git.respond(['ls-files', '--others', '--exclude-standard'], git.ok());
        git.respondToPrefix(['-C'], git.ok('dean/featureSquash'));
        f.feature.processes.respondToShell(
            'echo mocked-fresh-build',
            f.feature.processes.exited(0, 'fresh build passed\n'),
        );
        const output = CapturedOutput.start();
        const cwd = vi.spyOn(process, 'cwd').mockReturnValue(f.root);
        try {
            await f.feature.container.get(PrGateApp).reviewUpsertPr();
            const saved = JSON.parse(
                fs.readFileSync(path.join(f.destination, 'review-stage.json'), 'utf8'),
            );
            expect(saved).toMatchObject({
                headSha: HEAD,
                round: 1,
                maxReviewerRounds: 1,
                buildHeadSha: 'e'.repeat(40),
                reviewersBriefed: ['security', 'requirements'],
            });
            expect(f.feature.processes.shellCalls).toHaveLength(1);
            expect(output.stdout).toContain('carried');
            expect(output.stdout).not.toContain('SPAWN');
            expect(fs.existsSync(path.join(f.destination, 'review-round2-security.json'))).toBe(
                false,
            );
            expect(
                fs.readFileSync(path.join(f.destination, 'review-round1-security.provenance.json')),
            ).toEqual(
                fs.readFileSync(path.join(f.source, 'review-round1-security.provenance.json')),
            );
        } finally {
            cwd.mockRestore();
            output.stop();
        }
    });
    it('preserves the pending Squash transaction, current phase and A/B/C refs byte-for-byte', async () => {
        const f = await fixture();
        checkoutLayout.primary(f.root, 'dean/featureSquash');
        const merge = path.join(f.root, '.webpieces/merge-info/staged', SLUG, 'merge-1');
        fs.mkdirSync(merge, { recursive: true });
        const marker = JSON.stringify({
            currentBranch: 'dean/feature',
            squashBranch: 'dean/featureSquash',
            backupBranch: 'dean/featurePreMerge2',
            prNumber: '42',
            conflictedFiles: ['feature.ts'],
            validated: false,
        });
        const hashes = JSON.stringify({
            hashForkPoint: '1'.repeat(40),
            hashFeatureHead: '2'.repeat(40),
            hashMainHead: '3'.repeat(40),
        });
        fs.writeFileSync(path.join(merge, 'merge-in-progress.json'), marker);
        fs.writeFileSync(path.join(merge, 'updatemain-hashes.json'), hashes);
        const phase = path.join(f.destination, 'stages/stage1-start.json');
        fs.mkdirSync(path.dirname(phase), { recursive: true });
        fs.writeFileSync(phase, 'current pending Squash phase');
        f.write('stages/stage1-start.json', {
            historicalPhase: 'original finished PR',
            head: HEAD,
        });
        const gitHead = fs.readFileSync(path.join(f.root, '.git/HEAD'));
        await f.run();
        expect(fs.readFileSync(path.join(merge, 'merge-in-progress.json'), 'utf8')).toBe(marker);
        expect(fs.readFileSync(path.join(merge, 'updatemain-hashes.json'), 'utf8')).toBe(hashes);
        expect(fs.readFileSync(path.join(f.root, '.git/HEAD'))).toEqual(gitHead);
        expect(fs.readFileSync(phase, 'utf8')).toBe('current pending Squash phase');
        expect(
            fs.readFileSync(
                path.join(f.destination, 'recovered-original-state/stages/stage1-start.json'),
            ),
        ).toEqual(fs.readFileSync(path.join(f.source, 'stages/stage1-start.json')));
        expect(
            f.feature.git
                .commandLines()
                .every((line) => !/commit|checkout|reset|update-ref/.test(line)),
        ).toBe(true);
    });
    it('refuses a differing active receipt before installing evidence and preserves its current identity', async () => {
        const f = await fixture();
        fs.mkdirSync(f.destination, { recursive: true });
        const current = JSON.stringify({
            headSha: 'e'.repeat(40),
            buildHeadSha: 'e'.repeat(40),
            mergeValidated: false,
            round: 0,
            phase: 'current Squash transaction',
        });
        fs.writeFileSync(path.join(f.destination, 'review-stage.json'), current);
        await expect(f.run()).rejects.toThrow('destination conflict: review-stage.json');
        expect(fs.readFileSync(path.join(f.destination, 'review-stage.json'), 'utf8')).toBe(
            current,
        );
        expect(fs.readdirSync(f.destination)).toEqual(['review-stage.json']);
    });
    it('authenticates later author-fix materialization without relabeling the original reviewed scope', async () => {
        const f = await fixture();
        f.evidence(PUBLISHED);
        const result = await f.cli();
        expect(result.code).toBe(0);
        expect(result.output).toContain(`"historicalReviewedSha": "${HEAD}"`);
        expect(result.output).toContain(`"head": "${PUBLISHED}"`);
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it.each([
        'pr-context.json',
        'stages/stage2-review.json',
        'diff/manifest.json',
        'diff/ALL.diff',
        'diff/files/feature.ts.diff',
        'instructions/security.instructions.md',
    ])('the published CLI refuses missing promised artifact %s without writing', async (name) => {
        const f = await fixture();
        fs.unlinkSync(path.join(f.source, name));
        const result = await f.cli();
        expect(result.code).toBe(1);
        expect(result.error).toContain('Missing required historical artifact');
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it.each([
        'context-lineage',
        'stage2-inventory',
        'manifest-lineage',
        'manifest-inventory',
        'patch-content',
        'combined-content',
        'instruction-identity',
        'instruction-lineage',
        'instruction-scope',
        'consistent-false-scope',
    ])('the published CLI refuses contradictory %s before any write', async (problem) => {
        const f = await fixture();
        if (problem === 'context-lineage')
            f.write('pr-context.json', {
                base: BASE,
                head: 'f'.repeat(40),
                dirty: false,
                changedFiles: ['feature.ts'],
            });
        if (problem === 'stage2-inventory')
            f.write('stages/stage2-review.json', {
                base: BASE,
                head: HEAD,
                dirty: false,
                changedFiles: ['invented.ts'],
            });
        if (problem === 'manifest-lineage' || problem === 'manifest-inventory') {
            const value = JSON.parse(
                fs.readFileSync(path.join(f.source, 'diff/manifest.json'), 'utf8'),
            );
            if (problem === 'manifest-lineage') value.head = value.hashFeatureHead = 'f'.repeat(40);
            else value.entries = [];
            f.write('diff/manifest.json', value);
        }
        if (problem === 'patch-content')
            fs.writeFileSync(
                path.join(f.source, 'diff/files/feature.ts.diff'),
                PATCH.replace('+new', '+bad'),
            );
        if (problem === 'combined-content')
            fs.writeFileSync(path.join(f.source, 'diff/ALL.diff'), PATCH.replace('+new', '+bad'));
        if (problem.startsWith('instruction-')) {
            const name = path.join(f.source, 'instructions/security.instructions.md');
            let body = fs.readFileSync(name, 'utf8');
            if (problem === 'instruction-identity')
                body = body.replace('# Checklist `security`', '# Checklist `other`');
            if (problem === 'instruction-lineage') body = body.replace(HEAD, 'f'.repeat(40));
            if (problem === 'instruction-scope')
                body = body.replace('`feature.ts`', '`invented.ts`');
            fs.writeFileSync(name, body);
        }
        if (problem === 'consistent-false-scope') {
            const receipt = JSON.parse(
                fs.readFileSync(path.join(f.source, 'review-stage.json'), 'utf8'),
            );
            receipt.scopeHashes.security = receipt.scopeHashes.requirements = 'e'.repeat(64);
            f.write('review-stage.json', receipt);
            for (const id of ['security', 'requirements']) {
                const name = `review-round1-${id}.provenance.json`;
                const record = JSON.parse(fs.readFileSync(path.join(f.source, name), 'utf8'));
                record.scopeHash = 'e'.repeat(64);
                f.write(name, record);
            }
        }
        const result = await f.cli();
        expect(result.code).toBe(1);
        expect(result.output).not.toContain('Validated');
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it('defaults to read-only validation with explicit audit hashes', async () => {
        const f = await fixture();
        expect(await f.run(false)).toContain('Validated (dry run)');
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it('is idempotent and resumes a partial restore without overwriting history', async () => {
        const f = await fixture();
        fs.mkdirSync(f.destination, { recursive: true });
        fs.copyFileSync(
            path.join(f.source, 'review-round1-security.json'),
            path.join(f.destination, 'review-round1-security.json'),
        );
        await f.run();
        const before = fs.readFileSync(path.join(f.destination, 'review-recovery.json'));
        await f.run();
        expect(fs.readFileSync(path.join(f.destination, 'review-recovery.json'))).toEqual(before);
    });
    it.each([
        'verdict',
        'provenance',
        'scope',
        'missing',
        'orange',
        'round',
        'published',
        'repository',
        'branch',
    ])('refuses %s mismatch without installing state', async (problem) => {
        const f = await fixture();
        if (problem === 'verdict')
            f.write('review-round1-security.json', {
                id: 'security',
                status: 'green',
                agent: 'codex',
                model: 'test',
                output: 'edited',
            });
        if (problem === 'provenance')
            fs.unlinkSync(path.join(f.source, 'review-round1-security.provenance.json'));
        if (problem === 'scope') {
            const name = 'review-round1-security.provenance.json';
            const record = JSON.parse(fs.readFileSync(path.join(f.source, name), 'utf8'));
            record.scopeHash = 'e'.repeat(64);
            f.write(name, record);
        }
        if (problem === 'missing')
            fs.unlinkSync(path.join(f.source, 'review-round1-security.json'));
        if (problem === 'orange') fs.unlinkSync(path.join(f.source, 'review-round1-fixes.json'));
        if (problem === 'round') {
            const record = JSON.parse(
                fs.readFileSync(path.join(f.source, 'review-stage.json'), 'utf8'),
            );
            record.round = 2;
            f.write('review-stage.json', record);
        }
        if (problem === 'published') f.write('stages/stage3-finish.json', { head: HEAD });
        if (problem === 'repository')
            fs.writeFileSync(
                path.join(f.source, 'pr-body.md'),
                'https://github.com/other/repo/pull/42',
            );
        if (problem === 'branch') f.branch = 'other/feature';
        await expect(f.run()).rejects.toThrow();
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it('preflights every destination conflict before installing any historical file', async () => {
        const f = await fixture();
        fs.mkdirSync(f.destination, { recursive: true });
        fs.writeFileSync(
            path.join(f.destination, 'review-round1-requirements.json'),
            'different review',
        );
        await expect(f.run()).rejects.toThrow('destination conflict');
        expect(fs.readdirSync(f.destination)).toEqual(['review-round1-requirements.json']);
    });
    it('refuses orphaned provenance even when it would expand the round budget', async () => {
        const f = await fixture();
        f.write('review-round2-orphan.provenance.json', { round: 2 });
        await expect(f.run()).rejects.toThrow('frozen round budget');
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it('also preflights destination conflicts in dry-run mode', async () => {
        const f = await fixture();
        fs.mkdirSync(f.destination, { recursive: true });
        fs.writeFileSync(path.join(f.destination, 'review-stage.json'), 'different state');
        await expect(f.run(false)).rejects.toThrow('destination conflict');
        expect(fs.readdirSync(f.destination)).toEqual(['review-stage.json']);
    });
    it('refuses linked destination ancestors without writing outside the checkout', async () => {
        const f = await fixture();
        const elsewhere = specTempDirs.make('wp-recovery-linked-');
        fs.symlinkSync(elsewhere, path.join(f.root, '.webpieces'), 'dir');
        await expect(f.run()).rejects.toThrow('linked or non-directory');
        expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
    it('refuses a symlink in the source', async () => {
        const f = await fixture();
        fs.symlinkSync(
            path.join(f.source, 'pr-body.md'),
            path.join(f.source, 'review-round1-linked.json'),
        );
        await expect(f.run()).rejects.toThrow('non-file');
        expect(fs.existsSync(f.destination)).toBe(false);
    });
});
