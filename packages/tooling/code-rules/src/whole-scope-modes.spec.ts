import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    allRuleNames,
    BaseRuleConfig,
    DiffScope,
    FileScope,
    WholeScopeModes,
    FrameworkTagConfig,
    InformAiError,
    MaxMethodLinesConfig,
    NoAnyUnknownConfig,
    NoInlineTypeLiteralsConfig,
    OneEnumSpellingInApiLibConfig,
    RequireReturnTypeConfig,
    RequiredTypeSuffixConfig,
    RequiredTypeSuffixEntry,
    RuleFailError,
    schemaModeValues,
    sectionForRule,
    seedEntryForRule,
    specTempDirs,
    toError,
    WHOLE_SCOPE_MODES,
} from '@webpieces/rules-config';

import { CodeValidator, ExecutorResult } from './code-validator';
import { CONFIG_BINDINGS } from './code-rules-config-table';
import { CodeRulesRunRequest, CodeRulesRunRequestParser } from './code-rules-run-request';
import { ProjectRoleResolver } from './project-role-resolver';
import { RuleScopePlanner } from './rule-scope-plan';
import { MaxMethodLinesValidator } from './validate-modified-methods';
import { NoAnyUnknownValidator } from './validate-no-any-unknown';
import { NoInlineTypeLiteralsValidator } from './validate-no-inline-types';
import { RequireReturnTypeValidator } from './validate-return-types';
import { OneEnumSpellingInApiLibValidator } from './validate-one-enum-spelling-in-api-lib';
import { RequiredTypeSuffixValidator } from './validate-required-type-suffix';
import runValidator from './validate-code';

/**
 * #1027 acceptance: MODIFIED_PROJECTS and RUN_EVERY_TIME on every diff-scoped code rule, and the debug
 * run (`--rule` / `--mode` / `--projects`). A violating file that is NOT in the diff must FAIL under
 * RUN_EVERY_TIME, and under MODIFIED_PROJECTS when its project is touched — and PASS under both
 * NEW_AND_MODIFIED_* modes. Exercised through the same planner + DiffScope.within the engine uses, on
 * rules of every shape (line-scoped, method-scoped, the method-limit pair, api-lib), in a real git repo.
 */

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');

class Repo {
    readonly root = specTempDirs.makeReal('whole-scope-');

    constructor() {
        this.git('init -q -b main');
        this.git('config user.email test@test.com');
        this.git('config user.name test');
        this.project('libs/apis', 'api-lib');
        this.project('libs/util', 'lib');
        // The violations, committed BEFORE the diff — so no NEW_AND_MODIFIED_* mode ever sees them.
        this.write('libs/apis/src/Old.ts', [
            "export type Old = 'a' | 'b';",
            'export const loose: any = 1;',
            'export class Big {',
            '    long(opts: { a: number }): number {',
            ...Array.from({ length: 12 }, (_: undefined, i: number) => `        const v${i} = ${i};`),
            '        return 0;',
            '    }',
            '    untyped() {',
            '        return 1;',
            '    }',
            '}',
            '',
        ].join('\n'));
        this.write('libs/apis/src/Touch.ts', 'export const touch = 0;\n');
        this.write('libs/util/src/Util.ts', 'export const util = 0;\n');
        this.git('add -A');
        this.git('commit -q -m base');
        process.env['NX_BASE'] = this.git('rev-parse HEAD');
        delete process.env['NX_HEAD'];
    }

    git(cmd: string): string {
        // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
        return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
            cwd: this.root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    }

    project(dir: string, role: string): void {
        this.write(`${dir}/project.json`, JSON.stringify({ name: path.basename(dir), tags: [`role:${role}`] }));
    }

    write(relPath: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relPath), content);
    }

    /** A webpieces.config.json that loads: this repo's own, plus a seeded entry for every rule it lacks. */
    writeConfig(): void {
        const config = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, 'webpieces.config.json'), 'utf-8')) as Record<string, Record<string, unknown>>;
        for (const name of allRuleNames()) {
            const section = config[sectionForRule(name)];
            if (section[name] === undefined) section[name] = seedEntryForRule(name);
        }
        config['rules']['one-enum-spelling-in-api-lib'] = seedEntryForRule('one-enum-spelling-in-api-lib');
        // The review checklists name docs under THIS repo's .claude/review, which the fixture does not have.
        (config['commands']['pr-gate'] as Record<string, unknown>)['checklists'] = [];
        this.write('webpieces.config.json', JSON.stringify(config, null, 4));
        this.git('add -A');
        this.git('commit -q -m config');
        process.env['NX_BASE'] = this.git('rev-parse HEAD');
    }

    dispose(): void {
        delete process.env['NX_BASE'];
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

/** A rule factory for one of the three shapes under test. */
class RuleUnderTest {
    constructor(
        readonly key: string,
        readonly config: () => BaseRuleConfig,
        readonly build: (config: BaseRuleConfig) => CodeValidator<BaseRuleConfig>,
    ) {}

    /** Run the rule at `mode` exactly as the engine does: planned config, inside its planned scope. */
    async passes(root: string, mode: string): Promise<boolean> {
        const committed = this.config();
        committed.mode = mode;
        const planner = new RuleScopePlanner(CodeRulesRunRequest.GATE, null);
        const planned = planner.plan(this.key, committed, schemaModeValues(this.key) ?? []);
        const validator = this.build(planned);
        try {
            const result: ExecutorResult = await new DiffScope().within(planner.result().of(this.key), () => validator.run(root));
            return result.success;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof RuleFailError) return false;
            throw error;
        }
    }
}

const RULES: readonly RuleUnderTest[] = [
    new RuleUnderTest('no-any-unknown', () => new NoAnyUnknownConfig(),
        (c: BaseRuleConfig) => new NoAnyUnknownValidator(c as NoAnyUnknownConfig)),
    new RuleUnderTest('max-method-lines', () => {
        const c = new MaxMethodLinesConfig();
        c.limit = 5;
        return c;
    }, (c: BaseRuleConfig) => new MaxMethodLinesValidator(c as MaxMethodLinesConfig)),
    new RuleUnderTest('require-return-type', () => new RequireReturnTypeConfig(),
        (c: BaseRuleConfig) => new RequireReturnTypeValidator(c as RequireReturnTypeConfig)),
    new RuleUnderTest('no-inline-type-literals', () => new NoInlineTypeLiteralsConfig(),
        (c: BaseRuleConfig) => new NoInlineTypeLiteralsValidator(c as NoInlineTypeLiteralsConfig)),
    new RuleUnderTest('one-enum-spelling-in-api-lib', () => new OneEnumSpellingInApiLibConfig(),
        (c: BaseRuleConfig) => new OneEnumSpellingInApiLibValidator(c as OneEnumSpellingInApiLibConfig, new ProjectRoleResolver(), new DiffScope())),
    // #1037: `Old` (libs/apis/src/Old.ts) does not end in `Dto`.
    new RuleUnderTest('required-type-suffix', () => {
        const entry = new RequiredTypeSuffixEntry();
        entry.paths = ['libs/apis/**'];
        entry.suffixes = ['Dto'];
        const c = new RequiredTypeSuffixConfig();
        c.entries = [entry];
        return c;
    }, (c: BaseRuleConfig) => new RequiredTypeSuffixValidator(c as RequiredTypeSuffixConfig, new ProjectRoleResolver(), new DiffScope())),
];

describe('whole-scope modes judge a violating file the diff never touched', () => {
    let repo: Repo;
    let quiet: ReturnType<typeof vi.spyOn>[];

    beforeEach(() => {
        repo = new Repo();
        quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    });

    afterEach(() => {
        for (const spy of quiet) spy.mockRestore();
        repo.dispose();
    });

    for (const rule of RULES) {
        it(`${rule.key}: FAILS under RUN_EVERY_TIME and under MODIFIED_PROJECTS when its project is touched; PASSES under NEW_AND_MODIFIED_*`, async () => {
            repo.write('libs/apis/src/Touch.ts', 'export const touch = 1;\n');
            const diffModes = (schemaModeValues(rule.key) ?? []).filter((m: string) => m.startsWith('NEW_'));

            expect(await rule.passes(repo.root, 'RUN_EVERY_TIME')).toBe(false);
            expect(await rule.passes(repo.root, 'MODIFIED_PROJECTS')).toBe(false);
            for (const mode of diffModes) {
                expect(await rule.passes(repo.root, mode), mode).toBe(true);
            }
        });

        it(`${rule.key}: MODIFIED_PROJECTS PASSES when the diff touches only another project`, async () => {
            repo.write('libs/util/src/Util.ts', 'export const util = 1;\n');

            expect(await rule.passes(repo.root, 'MODIFIED_PROJECTS')).toBe(true);
            expect(await rule.passes(repo.root, 'RUN_EVERY_TIME')).toBe(false);
        });
    }
});

describe('every diff-scoped code rule offers both whole-scope modes, and no rule gained a default', () => {
    it('each CONFIG_BINDINGS rule with a diff-scoped mode accepts MODIFIED_PROJECTS and RUN_EVERY_TIME', () => {
        const diffScoped = CONFIG_BINDINGS.map((b: readonly [unknown, string]) => b[1])
            .filter((key: string) => new WholeScopeModes().wholeFileJudgeMode(schemaModeValues(key) ?? []) !== null);

        expect(diffScoped.length).toBeGreaterThan(20);
        for (const key of diffScoped) {
            expect(schemaModeValues(key), key).toEqual(expect.arrayContaining([...WHOLE_SCOPE_MODES]));
        }
    });
});

describe('RuleScopePlanner', () => {
    it('leaves the gate path byte-identical: a diff-scoped mode keeps the committed config object', () => {
        const config = new NoAnyUnknownConfig();
        config.mode = 'NEW_AND_MODIFIED_CODE';
        const planner = new RuleScopePlanner(CodeRulesRunRequest.GATE, null);

        expect(planner.plan('no-any-unknown', config, schemaModeValues('no-any-unknown') ?? [])).toBe(config);
        expect(planner.result().of('no-any-unknown')).toBe(FileScope.DIFF);
    });

    it('rewrites a whole-scope mode to the rule\'s per-file mode inside a widened scope, never mutating the committed config', () => {
        const config = new NoAnyUnknownConfig();
        config.mode = 'RUN_EVERY_TIME';
        const planner = new RuleScopePlanner(CodeRulesRunRequest.GATE, null);
        const planned = planner.plan('no-any-unknown', config, schemaModeValues('no-any-unknown') ?? []);

        expect(planned.mode).toBe('NEW_AND_MODIFIED_FILES');
        expect(planned).toBeInstanceOf(NoAnyUnknownConfig);
        expect(config.mode).toBe('RUN_EVERY_TIME');
        expect(planner.result().of('no-any-unknown').kind).toBe('RUN_EVERY_TIME');
    });

    it('leaves a PROJECT_MODES rule\'s own MODIFIED_PROJECTS alone — it is native there, not a widening', () => {
        const config = new FrameworkTagConfig();
        config.mode = 'MODIFIED_PROJECTS';
        const planner = new RuleScopePlanner(CodeRulesRunRequest.GATE, null);

        expect(planner.plan('framework-tag', config, schemaModeValues('framework-tag') ?? [])).toBe(config);
    });

    it('a debug run takes --mode for its one rule, scopes it to --projects, and ignores the escape hatches', () => {
        const config = new NoAnyUnknownConfig();
        config.mode = 'NEW_AND_MODIFIED_CODE';
        config.turnOffRuleUntilEpoch = 9999999999;
        const planner = new RuleScopePlanner(new CodeRulesRunRequest('no-any-unknown', 'RUN_EVERY_TIME', ['apis']), ['libs/apis']);
        const planned = planner.plan('no-any-unknown', config, schemaModeValues('no-any-unknown') ?? []);
        const scopes = planner.result();

        expect(planned.turnOffRuleUntilEpoch).toBe(0);
        expect(scopes.of('no-any-unknown').projectRoots).toEqual(['libs/apis']);
        expect(scopes.debugTarget?.committedMode).toBe('NEW_AND_MODIFIED_CODE');
        expect(scopes.debugTarget?.mode).toBe('RUN_EVERY_TIME');
    });

    it('refuses a debug --mode the rule does not have, a committed OFF with no --mode, and an unknown rule', () => {
        const off = new NoAnyUnknownConfig();
        off.mode = 'OFF';
        const modes = schemaModeValues('no-any-unknown') ?? [];

        expect(() => new RuleScopePlanner(new CodeRulesRunRequest('no-any-unknown', 'NEW_METHODS', null), null)
            .plan('no-any-unknown', off, modes)).toThrow(/--mode=NEW_METHODS is not a mode of no-any-unknown/);
        expect(() => new RuleScopePlanner(new CodeRulesRunRequest('no-any-unknown', null, null), null)
            .plan('no-any-unknown', off, modes)).toThrow(/"mode": "OFF".*--mode=<MODE>/);
        expect(() => new RuleScopePlanner(new CodeRulesRunRequest('no-such-rule', null, null), null).result())
            .toThrow(InformAiError);
    });
});

describe('CodeRulesRunRequest', () => {
    it('parses the bin\'s flags, and an empty argv is the gate', () => {
        const request = new CodeRulesRunRequestParser().fromArgv(['--rule=no-any-unknown', '--mode=RUN_EVERY_TIME', '--projects=a, b']);

        expect([request.rule, request.mode, request.projects]).toEqual(['no-any-unknown', 'RUN_EVERY_TIME', ['a', 'b']]);
        expect(new CodeRulesRunRequestParser().fromArgv([])).toBe(CodeRulesRunRequest.GATE);
        expect(new CodeRulesRunRequestParser().fromExecutorOptions({ projects: ['a', 'b'], rule: 'x' }).projects).toEqual(['a', 'b']);
    });

    it('refuses --mode / --projects without --rule, and an unknown flag', () => {
        expect(() => new CodeRulesRunRequestParser().fromArgv(['--mode=RUN_EVERY_TIME'])).toThrow(/need --rule=<rule>/);
        expect(() => new CodeRulesRunRequestParser().fromExecutorOptions({ projects: 'a' })).toThrow(/need --rule=<rule>/);
        expect(() => new CodeRulesRunRequestParser().fromArgv(['--verbose'])).toThrow(/Unknown argument '--verbose'/);
    });
});

describe('the debug run, end to end through validate-code', () => {
    let repo: Repo;
    let printed: string[];
    let spies: ReturnType<typeof vi.spyOn>[];

    beforeEach(() => {
        repo = new Repo();
        repo.writeConfig();
        printed = [];
        const record = (...args: Parameters<typeof console.log>): void => {
            printed.push(args.map(String).join(' '));
        };
        spies = [vi.spyOn(console, 'log').mockImplementation(record), vi.spyOn(console, 'error').mockImplementation(record)];
    });

    afterEach(() => {
        for (const spy of spies) spy.mockRestore();
        repo.dispose();
    });

    it('--mode=RUN_EVERY_TIME --projects=apis: labelled, prints the rule\'s own text, counts per project, fails', async () => {
        const result = await runValidator(repo.root, new CodeRulesRunRequest('one-enum-spelling-in-api-lib', 'RUN_EVERY_TIME', ['apis']));
        const out = printed.join('\n');

        expect(result.success).toBe(false);
        expect(out).toContain('DEBUG RUN — not the gate');
        expect(out).toContain('mode:     RUN_EVERY_TIME (committed: NEW_AND_MODIFIED_CODE)');
        expect(out).toContain('libs/apis/src/Old.ts:1');
        expect(out).toMatch(/apis\s+1\n\s+TOTAL\s+1/);
        expect(out).not.toContain('Validating No Any/Unknown');
    });

    it('--projects restricts the report to the named projects', async () => {
        const result = await runValidator(repo.root, new CodeRulesRunRequest('one-enum-spelling-in-api-lib', 'RUN_EVERY_TIME', ['util']));

        expect(result.success).toBe(true);
        expect(printed.join('\n')).toMatch(/util\s+0\n\s+TOTAL\s+0/);
    });

    it('without --mode it judges the COMMITTED mode over --projects — the grandfathered site is not reported', async () => {
        const result = await runValidator(repo.root, new CodeRulesRunRequest('one-enum-spelling-in-api-lib', null, ['apis']));

        expect(result.success).toBe(true);
        expect(printed.join('\n')).toContain('mode:     NEW_AND_MODIFIED_CODE (committed)');
    });
});
