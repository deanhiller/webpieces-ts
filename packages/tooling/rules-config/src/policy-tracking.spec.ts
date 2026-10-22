import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitResultDto, RepositoryLayout } from '@webpieces/tooling-common';
import { CheckoutLayout, ProcessCallDto, specTempDirs } from '@webpieces/tooling-testkit';
import { RulesConfigFeature } from './__tests__/rules-config-feature';
import { PolicyTracking, UntrackedPolicyError } from './policy-tracking';
import { PackPolicyDeclaration } from './pack-policy-files';
import { ConfigRepairCure } from './config-repair-error';
import { toError } from '@webpieces/tooling-common/to-error';

/**
 * git's INDEX for one scratch checkout (#1381): which paths are tracked, and which the `.gitignore` on
 * disk ignores. The mocked git edge answers PolicyTracking's four commands from it exactly as git does —
 * `check-ignore` exits 0 naming the ignored paths and 1 when none are, `ls-files -z` lists the tracked
 * ones, `rm --cached` untracks, `add -A` tracks what is not ignored — so each scenario holds what the
 * program asked git and what it concluded, and no git process is started.
 */
class GitIndex {
    readonly tracked = new Set<string>();

    constructor(private readonly root: string) {}

    answer(call: ProcessCallDto): GitResultDto {
        const args = call.args;
        const files = args.slice(args.indexOf('--') + 1);
        if (args[0] === 'check-ignore') {
            const ignored = files.filter((file: string): boolean => this.ignored(file));
            return ignored.length > 0 ? new GitResultDto(0, ignored.join('\n') + '\n', '') : new GitResultDto(1, '', '');
        }
        if (args.includes('ls-files')) {
            const listed = files.filter((file: string): boolean => this.tracked.has(path.normalize(file)));
            return new GitResultDto(0, listed.map((file: string): string => `${file}\0`).join(''), '');
        }
        if (args[0] === 'rm') {
            for (const file of [...this.tracked]) if (file.startsWith('.webpieces/')) this.tracked.delete(file);
            return new GitResultDto(0, '', '');
        }
        if (args.includes('add')) {
            for (const file of files) if (!this.ignored(file)) this.tracked.add(path.normalize(file));
            return new GitResultDto(0, '', '');
        }
        return new GitResultDto(1, '', `unscripted git ${args.join(' ')}`);
    }

    // A path is ignored when a `.gitignore` line names a directory it lives under.
    ignored(file: string): boolean {
        const gitignore = fs.readFileSync(path.join(this.root, '.gitignore'), 'utf8');
        return gitignore.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line !== '')
            .some((pattern: string): boolean => file.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`));
    }
}

class TrackingFixture {
    readonly root = specTempDirs.makeReal('wp-tracked-policy-');
    readonly index = new GitIndex(this.root);
    readonly declarations = [
        new PackPolicyDeclaration('@client/pack', '.webpieces-config/rules/client.json'),
    ];

    private constructor(readonly feature: RulesConfigFeature, readonly tracking: PolicyTracking) {
        CheckoutLayout.primary(this.root, 'main');
        fs.mkdirSync(path.join(this.root, '.webpieces-config/rules'), { recursive: true });
        fs.writeFileSync(path.join(this.root, '.webpieces-config/rules/client.json'), '{}');
        fs.writeFileSync(path.join(this.root, 'webpieces.config.json'), '{}');
        fs.writeFileSync(path.join(this.root, '.gitignore'), '.webpieces/\n');
        feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => this.index.answer(call));
    }

    static async create(): Promise<TrackingFixture> {
        const feature = await RulesConfigFeature.create();
        return new TrackingFixture(feature, feature.container.get(PolicyTracking));
    }

    /** The commands the program sent git, without the scratch root. */
    commands(): string[] {
        return this.feature.git.commandLines();
    }
}

describe('policy must be committed inputs', () => {
    it('blocks untracked policy, and accepts it once explicitly staged', async () => {
        const fixture = await TrackingFixture.create();
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).rejects.toThrow(
            'wp-migrate-dirs --stage',
        );
        await fixture.tracking.stage(fixture.root, fixture.declarations);
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).resolves.toBeUndefined();
        fs.mkdirSync(path.join(fixture.root, '.webpieces'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, '.webpieces/build.log'), 'runtime');
        // Runtime state stays out of the index: nothing under .webpieces/ was staged, and it is ignored.
        expect([...fixture.index.tracked].filter((file: string): boolean => file.startsWith('.webpieces/'))).toEqual([]);
        expect(fixture.index.ignored('.webpieces/build.log')).toBe(true);
        expect(fixture.commands()).toContain(
            'git --literal-pathspecs add -A -- webpieces.config.json .gitignore .webpieces-config/rules/client.json');
    });
    it('stages the old tracked policy deletions so a clone cannot recreate the retired layout', async () => {
        const fixture = await TrackingFixture.create();
        fs.mkdirSync(path.join(fixture.root, '.webpieces/rules'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, '.webpieces/rules/client.json'), '{}');
        // An older release committed policy under .webpieces/ (force-added past the ignore).
        fixture.index.tracked.add('.webpieces/rules/client.json');
        new RepositoryLayout().migrate(fixture.root);
        await fixture.tracking.stage(fixture.root, fixture.declarations);
        expect([...fixture.index.tracked].filter((file: string): boolean => file.startsWith('.webpieces/'))).toEqual([]);
        expect(fixture.commands()[0]).toBe('git rm -r -q --cached --ignore-unmatch -- .webpieces');
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).resolves.toBeUndefined();
    });
    it('blocks ignored policy even when it is already tracked', async () => {
        const fixture = await TrackingFixture.create();
        await fixture.tracking.stage(fixture.root, fixture.declarations);
        fs.appendFileSync(path.join(fixture.root, '.gitignore'), '.webpieces-config/\n');
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).rejects.toThrow(
            'policy is gitignored',
        );
    });
    it('requires a tracked symlink target as well as its declaration', async () => {
        const fixture = await TrackingFixture.create();
        await fixture.tracking.stage(fixture.root, fixture.declarations);
        const owner = path.join(fixture.root, fixture.declarations[0].config);
        fs.unlinkSync(owner);
        fs.writeFileSync(path.join(fixture.root, '.webpieces-config/rules/actual.json'), '{}');
        fs.symlinkSync('actual.json', owner);
        fixture.index.tracked.add(fixture.declarations[0].config);
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).rejects.toThrow(
            'actual.json',
        );
        await fixture.tracking.stage(fixture.root, fixture.declarations);
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).resolves.toBeUndefined();
    });
    it('names the exact untracked files and both cures, never git\'s own pathspec advice (#1327)', async () => {
        const fixture = await TrackingFixture.create();
        await fixture.tracking.stage(fixture.root, fixture.declarations);
        fs.writeFileSync(path.join(fixture.root, '.webpieces-config/rules/local.json'), '{}');
        const declarations = [
            ...fixture.declarations,
            new PackPolicyDeclaration('./local-pack.cjs', '.webpieces-config/rules/local.json'),
        ];
        let thrown: Error | null = null;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the spec inspects the thrown structure
        try {
            await fixture.tracking.check(fixture.root, declarations);
            // webpieces-disable no-any-unknown -- a caught value is unknown until narrowed
        } catch (err: unknown) {
            const error = toError(err);
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(UntrackedPolicyError);
        const error = thrown as UntrackedPolicyError;
        expect(error.untracked).toEqual(['.webpieces-config/rules/local.json']);
        expect(error.message).toContain('  .webpieces-config/rules/local.json');
        expect(error.message).not.toContain('client.json');
        expect(error.message).not.toContain('pathspec');
        expect(error.message).not.toContain('Did you forget');
        expect(error.cures.map((cure: ConfigRepairCure) => cure.command)).toEqual([
            'git add -- .webpieces-config/rules/local.json',
            'pnpm wp-migrate-dirs --stage',
        ]);
        expect(error.message).toContain('Fix Option 1: (preferred) git add -- .webpieces-config/rules/local.json');
        expect(error.message).toContain('Fix Option 2: pnpm wp-migrate-dirs --stage');
    });

    it('requires every declared owner file and nothing generated (#1273: there is no lock or catalog)', async () => {
        const fixture = await TrackingFixture.create();
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).rejects.toThrow('client.json');
        fixture.index.tracked.add('.webpieces-config/rules/client.json');
        await expect(fixture.tracking.check(fixture.root, fixture.declarations)).resolves.toBeUndefined();
    });
});
