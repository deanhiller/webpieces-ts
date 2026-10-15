import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';

import { policyFixture, specTempDirs } from '@webpieces/tooling-testkit';
import {
    ConfigObject,
    FieldDef,
    OwnedRuleDefinition,
    RuleContribution,
    RuleHelp,
    RulePackManifest,
} from '@webpieces/rules-sdk';
import {
    ConfigRepairCure,
    ConfigRepairError,
    RulePackRegistry,
    loadAndValidate,
    prepareLegacyUpgrade,
} from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { NormalizedEdit, NormalizedToolInput } from '@webpieces/hook-runtime';

import { run, runBash, runRead } from './runner';
import { runPipeline } from '../adapters/hook-core';

// The committed-shim self-guard compares THIS checkout's shim against the local renderer; it has nothing to
// do with config repair, so it is neutralized exactly as hook-app-golden.spec.ts does.
vi.mock('../bin/hook-registration', async (importOriginal: () => Promise<typeof import('../bin/hook-registration')>) => {
    const actual = await importOriginal();
    return { ...actual, managedSurfaceDrift: (): readonly string[] => [] };
});

const CRASH = 'hook crashed unexpectedly';
const OWNER_0 = '.webpieces-config/rules/fixture-0.json';
const OWNER_1 = '.webpieces-config/rules/fixture-1.json';

/** A real git repo holding a fully valid config, every guard OFF so only config repair can decide. */
class RepairRepo {
    readonly root = specTempDirs.makeReal('wp-repair-cures-');

    constructor(manifests: readonly RulePackManifest[] = policyFixture.manifests()) {
        this.git('init', '-q', '-b', 'main');
        this.git('config', 'core.hooksPath', '/dev/null');
        this.git('config', 'user.email', 'test@example.com');
        this.git('config', 'user.name', 'test');
        fs.writeFileSync(nodePath.join(this.root, '.gitignore'), '.webpieces/\n');
        // webpieces-disable no-any-unknown -- opaque JSON config shape, only mutated by known keys here
        const config = prepareLegacyUpgrade({}, new RulePackRegistry(manifests)).config as Record<string, any>;
        config.hookGuards['branch-creation-guard'].autoReapMergedBranches = false;
        for (const name of Object.keys(config.hookGuards)) config.hookGuards[name].mode = 'OFF';
        config.excludePaths = [];
        policyFixture.writeOwnerConfig(this.root, config, manifests);
        fs.writeFileSync(nodePath.join(this.root, 'f.txt'), 'x');
        this.git('add', '-A');
        this.git('commit', '-q', '-m', 'init');
    }

    git(...args: string[]): void {
        execFileSync('git', args, { cwd: this.root, stdio: 'pipe' });
    }

    path(relative: string): string {
        return nodePath.join(this.root, relative);
    }

    // webpieces-disable no-any-unknown -- the fixture edits opaque owner JSON by rule id
    readJson(relative: string): Record<string, any> {
        return JSON.parse(fs.readFileSync(this.path(relative), 'utf8'));
    }

    // webpieces-disable no-any-unknown -- the fixture edits opaque owner JSON by rule id
    writeJson(relative: string, value: Record<string, any>): void {
        fs.writeFileSync(this.path(relative), JSON.stringify(value, null, 2) + '\n');
    }

    /** The structured error the config load throws — the one the deny is rendered from. */
    repairError(): ConfigRepairError {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the spec inspects the thrown structure
        try {
            loadAndValidate(this.root);
        // webpieces-disable no-any-unknown -- a caught value is unknown until narrowed
        } catch (err: unknown) {
            const error = toError(err);
            expect(error).toBeInstanceOf(ConfigRepairError);
            return error as ConfigRepairError;
        }
        throw new Error('expected the config load to fail');
    }

    /** One hook invocation through the real pipeline; returns the deny reason, or null for an allow. */
    // webpieces-disable no-any-unknown -- the tool input IS the wire payload
    hook(mode: 'guards' | 'rules', toolName: string, toolInput: Record<string, unknown>): string | null {
        const payload = JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: 'sess-repair',
            transcript_path: '/dev/null',
            cwd: this.root,
            tool_name: toolName,
            tool_input: toolInput,
        });
        const stdout = runPipeline(payload, mode).stdout.trim();
        if (stdout === '') return null;
        const parsed = JSON.parse(stdout);
        const decision = parsed.hookSpecificOutput?.permissionDecision;
        return decision === 'deny' ? String(parsed.hookSpecificOutput.permissionDecisionReason) : null;
    }

    write(mode: 'guards' | 'rules', file: string): string | null {
        return this.hook(mode, 'Write', { file_path: file, content: '{}\n' });
    }

    bash(command: string): string | null {
        return this.hook('guards', 'Bash', { command });
    }
}

/** Asserts ONE cure is reachable: its file edit through both hooks, or its command through the guards. */
class CureCheck {
    assertPermitted(repo: RepairRepo, cure: ConfigRepairCure): void {
        expect(cure.editFile !== null || cure.command !== null).toBe(true);
        if (cure.editFile !== null) {
            const input = new NormalizedToolInput(cure.editFile, [new NormalizedEdit('', '{}')]);
            expect(run('Write', input, repo.root, 'guards'), cure.editFile).toBeNull();
            expect(run('Edit', input, repo.root, 'rules'), cure.editFile).toBeNull();
            expect(repo.write('guards', cure.editFile), cure.editFile).toBeNull();
            expect(repo.write('rules', cure.editFile), cure.editFile).toBeNull();
        }
        if (cure.command !== null) {
            expect(runBash(cure.command, repo.root, 'guards', 'claude-code'), cure.command).toBeNull();
            expect(repo.bash(cure.command), cure.command).toBeNull();
        }
    }
}

/**
 * Every shape of config problem a hook can meet — each one a mutation of a valid repo. A new
 * ConfigRepairError throw site gets its shape added here, so the invariant below covers it.
 */
class BrokenConfig {
    constructor(
        readonly name: string,
        readonly breakIt: (repo: RepairRepo) => void,
        readonly names: string,
    ) {}
}

const BROKEN: readonly BrokenConfig[] = [
    new BrokenConfig('a required entry is missing', (repo: RepairRepo): void => {
        const entries = repo.readJson(OWNER_0);
        delete entries['max-file-lines'];
        repo.writeJson(OWNER_0, entries);
    }, 'missing required entry "max-file-lines"'),
    new BrokenConfig('an owner file holds an unknown key', (repo: RepairRepo): void => {
        repo.writeJson(OWNER_0, { ...repo.readJson(OWNER_0), 'no-such-rule': { mode: 'OFF' } });
    }, 'Delete the "no-such-rule" entry'),
    new BrokenConfig('an entry sits in the wrong owner file', (repo: RepairRepo): void => {
        const other = repo.readJson(OWNER_1);
        const id = Object.keys(other)[0];
        repo.writeJson(OWNER_0, { ...repo.readJson(OWNER_0), [id]: other[id] });
    }, 'paste it into'),
    new BrokenConfig('a field value is invalid', (repo: RepairRepo): void => {
        const entries = repo.readJson(OWNER_0);
        entries['max-file-lines'].mode = 'SOMETIMES';
        repo.writeJson(OWNER_0, entries);
    }, 'max-file-lines'),
    new BrokenConfig('a declared owner file is missing', (repo: RepairRepo): void => {
        fs.rmSync(repo.path(OWNER_1));
    }, 'missing rule-pack config'),
    new BrokenConfig('an owner file is not valid JSON', (repo: RepairRepo): void => {
        fs.writeFileSync(repo.path(OWNER_0), '{');
    }, 'Cannot parse rule-pack config'),
    new BrokenConfig('the root config holds conflict markers', (repo: RepairRepo): void => {
        fs.writeFileSync(repo.path('webpieces.config.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> main\n');
    }, 'could not be parsed as JSON'),
    new BrokenConfig('the root config holds an unknown top-level key', (repo: RepairRepo): void => {
        repo.writeJson('webpieces.config.json', { ...repo.readJson('webpieces.config.json'), mysteryKey: 1 });
    }, 'Unknown key "mysteryKey"'),
    new BrokenConfig('the root config declares no rulePacks', (repo: RepairRepo): void => {
        const root = repo.readJson('webpieces.config.json');
        delete root['rulePacks'];
        repo.writeJson('webpieces.config.json', root);
    }, 'rulePacks is required'),
    new BrokenConfig('a declared pack module is not installed', (repo: RepairRepo): void => {
        const root = repo.readJson('webpieces.config.json');
        root['rulePacks'][0].package = './absent-pack.cjs';
        repo.writeJson('webpieces.config.json', root);
    }, 'Rule-pack selection'),
    new BrokenConfig('owner config is still in the retired .webpieces/ directory', (repo: RepairRepo): void => {
        fs.mkdirSync(repo.path('.webpieces/rules'), { recursive: true });
        fs.writeFileSync(repo.path('.webpieces/rules/code.json'), '{}');
    }, 'wp-migrate-dirs'),
    new BrokenConfig('an owner file is not tracked by git', (repo: RepairRepo): void => {
        repo.git('rm', '-q', '--cached', '--', OWNER_0);
    }, 'must be tracked by git'),
    new BrokenConfig('committed policy is gitignored', (repo: RepairRepo): void => {
        fs.appendFileSync(repo.path('.gitignore'), '.webpieces-config/\n');
    }, 'policy is gitignored'),
];

describe('every config-repair deny names a cure the same hook permits (#1273)', () => {
    for (const broken of BROKEN) {
        it(`${broken.name}: a structured deny, never a crash, and every named cure is allowed`, () => {
            const repo = new RepairRepo();
            broken.breakIt(repo);
            const error = repo.repairError();
            expect(error.message).toContain(broken.names);
            expect(error.cures.length).toBeGreaterThan(0);

            // Ordinary work is refused with the error's own text, through the real pipeline.
            const deny = repo.bash('git status');
            expect(deny).not.toBeNull();
            expect(deny).not.toContain(CRASH);
            expect(deny).toContain(broken.names);
            const workDeny = repo.write('guards', repo.path('src/work.ts'));
            expect(workDeny).not.toBeNull();
            expect(workDeny).not.toContain(CRASH);

            // Reads always pass.
            expect(runRead(repo.path('webpieces.config.json'), repo.root, 'guards')).toBeNull();
            expect(repo.hook('guards', 'Read', { file_path: repo.path(OWNER_0) })).toBeNull();

            for (const cure of error.cures) new CureCheck().assertPermitted(repo, cure);
        });
    }
});

/**
 * Release N+1 installed under a config written for release N. The manifests are what `pnpm install`
 * changes; nothing committed records them, so a release that changes no rule changes nothing to decide.
 */
class NextRelease {
    constructor(private readonly release: readonly RulePackManifest[]) {}

    /** The same rules, a new version: the shape of a release that changed no policy. */
    sameRules(): RulePackManifest[] {
        return this.release.map((pack: RulePackManifest) => ({ ...pack, packageVersion: '2.0.0-fixture' }));
    }

    /** A new REQUIRED rule owned by the first pack — the one real decision an upgrade can ask for. */
    withNewRule(id: string, seed: ConfigObject): RulePackManifest[] {
        return this.sameRules().map((pack: RulePackManifest, index: number) =>
            index !== 0
                ? pack
                : {
                      ...pack,
                      ownedRules: [
                          ...pack.ownedRules,
                          new OwnedRuleDefinition(
                              id,
                              { mode: new FieldDef('string', ['ON', 'OFF']) }, // the registry merges the universal fields (#1253)
                              1,
                              {},
                              seed,
                              'rules',
                              new RuleHelp('A policy release N+1 added', 'Configure it in {configFile}.'),
                          ),
                      ],
                      contributions: [
                          ...pack.contributions,
                          new RuleContribution(id, pack.packageName, 'build', `${pack.packageName}/rule-runtime`),
                      ],
                  },
        );
    }
}

describe('upgrading the installed release under an existing config (#1273)', () => {
    it('a release that changes no rule: the first tool call passes, with no command and no file written', () => {
        const repo = new RepairRepo();
        policyFixture.declareIn(repo.root, new NextRelease(policyFixture.manifests()).sameRules());
        expect(repo.write('guards', repo.path('src/work.ts'))).toBeNull();
        expect(repo.bash('git status')).toBeNull();
        // No webpieces artifact diff: committed policy is exactly what release N left.
        const policyDiff = execFileSync(
            'git',
            ['status', '--porcelain', '--untracked-files=all', '--', '.webpieces-config', 'webpieces.config.json'],
            { cwd: repo.root, encoding: 'utf8' },
        );
        expect(policyDiff).toBe('');
    });

    it('a release that adds a required rule: the first call is a deny naming the file and entry, and the Edit cures it', () => {
        const repo = new RepairRepo();
        const id = 'policy-added-in-next-release';
        const seed = Object.assign(new ConfigObject(), {
            mode: 'ON',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
        });
        policyFixture.declareIn(repo.root, new NextRelease(policyFixture.manifests()).withNewRule(id, seed));

        const deny = repo.write('guards', repo.path('src/work.ts'));
        expect(deny).not.toBeNull();
        expect(deny).not.toContain(CRASH);
        expect(deny).toContain(`${repo.path(OWNER_0)}: missing required entry "${id}"`);
        expect(deny).toContain(`"${id}": ${JSON.stringify(seed)}`);

        // The cure is one Edit of the named file, permitted by both hooks while the config is invalid.
        expect(repo.write('guards', repo.path(OWNER_0))).toBeNull();
        expect(repo.write('rules', repo.path(OWNER_0))).toBeNull();
        repo.writeJson(OWNER_0, { ...repo.readJson(OWNER_0), [id]: { ...seed, mode: 'OFF' } });
        expect(repo.write('guards', repo.path('src/work.ts'))).toBeNull();
        expect(loadAndValidate(repo.root).resolved.rules.get(id)?.isOff).toBe(true);
    });
});
