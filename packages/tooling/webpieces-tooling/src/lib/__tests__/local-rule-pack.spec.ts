import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { PolicyRuntimeRequest } from '@webpieces/rules-sdk';
import { ConfigRepairError, RuleFailError, loadAndValidate, LoadedConfig } from '@webpieces/rules-config';
import { BlockedResult, HookFileEvaluation, NormalizedEdit, NormalizedToolInput, ToolKind } from '@webpieces/hook-runtime';
import { SourceHookRules } from '@webpieces/ai-hook-rules';
import { CodeRulesBootstrap, RunRequestParser } from '@webpieces/code-rules';
import { InformAiError } from '@webpieces/tooling-common';
import {
    ConfigObject,
    FieldDef,
    LocalRule,
    LocalRuleConfig,
    LocalRuleFile,
    LocalRuleFinding,
    LocalRulePack,
    Option,
    ts,
} from '../../local-rules';

/**
 * The gate's runner is loaded by PATH, exactly as the catch-must-propagate conformance spec loads
 * code-rules: this bundle depends on `@webpieces/nx-webpieces-rules` to SHIP it, and a static import from
 * a spec would make the package validator reclassify that shipping dependency as test-only.
 */
const PACK_BUILD_RUNNER = path.resolve(__dirname, '../../../../nx-webpieces-rules/src/pack-build-runner.ts');

/** The global the fixture repo's `.ts` pack module re-exports — the pack under test, built in THIS process. */
const FIXTURE_GLOBAL = '__webpiecesLocalRulePackFixture';
const PACK_MODULE = 'webpieces-rules/local-rules.ts';
const OWNER_FILE = '.webpieces-config/rules/local.json';
const RULE = 'no-banned-console';

class NoBannedConsoleConfig extends LocalRuleConfig {
    methods!: string[];
}

/** The tiny example the consumer guide shows: a syntax-only rule with one setting of its own. */
class NoBannedConsoleRule extends LocalRule<NoBannedConsoleConfig> {
    readonly id: string = RULE;
    readonly description = 'Production code must not call the banned console methods.';
    readonly files = ['**/*.ts'];
    readonly cures = [new Option('Throw a structured error, or log through the repo logger.', true)];
    readonly settings: Readonly<Record<string, FieldDef>> = { methods: FieldDef.nonEmptyStrings() };
    readonly seed = Object.assign(new ConfigObject(), { mode: 'NEW_AND_MODIFIED_CODE', methods: ['log'] });

    check(file: LocalRuleFile, config: NoBannedConsoleConfig): readonly LocalRuleFinding[] {
        const findings: LocalRuleFinding[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console'
                && config.methods.includes(node.expression.name.text)) {
                findings.push(new LocalRuleFinding(file.lineOf(node), file.endLineOf(node), `console.${node.expression.name.text}() is banned here.`));
            }
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return findings;
    }
}

/** The rule's entry in the pack's owner file. Data-only. */
class RuleEntry {
    mode = 'NEW_AND_MODIFIED_CODE';
    methods: string[] | undefined = ['log'];
    turnOffRuleUntilEpoch = 0;
    turnOffRuleWhileOnBranch: string | null = null;
    excludePaths: string[] | undefined = undefined;
}

const LEGACY = 'src/Legacy.ts';
const LEGACY_TEXT = ['export class Legacy {', '    old(): void { console.log("grandfathered"); }', '    edited(): number { return 1; }', '}', ''].join('\n');
const LEGACY_OLD = 'edited(): number { return 1; }';
const LEGACY_NEW = 'edited(): number { console.log("new"); return 1; }';
const FRESH = 'src/Fresh.ts';
const FRESH_TEXT = [
    'export class Fresh {',
    '    a(): void { console.log("a"); }',
    '    b(): void { console.warn("allowed: warn is not in methods"); }',
    '    c(): void {',
    '        // webpieces-disable no-banned-console -- the CLI entry point prints to the terminal',
    '        console.log("c");',
    '    }',
    '    d(): void {',
    '        // webpieces-disable no-banned-console',
    '        console.log("d");',
    '    }',
    '}',
    '',
].join('\n');

const OTHER = 'libs/other/src/Other.ts';
const OTHER_TEXT = 'export const other = (): void => console.log("other");\n';

// webpieces-disable no-function-outside-class -- spec-local git helper
function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

class ConsumerRepo {
    readonly root = specTempDirs.makeReal('wp-local-rules-');
    readonly pack: LocalRulePack;
    private readonly savedEnv = new Map<string, string | undefined>();

    constructor() {
        this.pack = new LocalRulePack('local-rules', path.join(this.root, PACK_MODULE), [new NoBannedConsoleRule()]);
        (globalThis as Record<string, LocalRulePack>)[FIXTURE_GLOBAL] = this.pack;
        git(this.root, 'init -q -b main');
        git(this.root, 'config user.email test@test.com');
        git(this.root, 'config user.name test');
        this.write('package.json', '{"private":true}\n');
        this.write('.gitignore', '.webpieces/\n');
        // The consumer's pack module, in TypeScript: loaded through the real transport with no build step.
        this.write(PACK_MODULE, [
            `const pack = (globalThis as Record<string, Record<string, object>>)['${FIXTURE_GLOBAL}'];`,
            "export const rulePackManifest = pack['rulePackManifest'];",
            "export const sourceRuleRuntime = pack['sourceRuleRuntime'];",
            "export const buildRuleRuntime = pack['buildRuleRuntime'];",
            "export const buildDebugRuntime = pack['buildDebugRuntime'];",
            '',
        ].join('\n'));
        this.write('webpieces.config.json', JSON.stringify({
            rulePacks: [{ package: `./${PACK_MODULE}`, config: OWNER_FILE }],
            commands: { 'pr-gate': { mode: 'OFF', buildCommand: 'pnpm test', gates: [] } },
            excludePaths: [],
            'match-rules': [],
        }, null, 2));
        this.configure(new RuleEntry());
        this.write(LEGACY, LEGACY_TEXT);
        // Two nx projects, so a debug run has something to restrict to and count per.
        this.write('src/project.json', '{"name":"app"}\n');
        this.write('libs/other/project.json', '{"name":"other"}\n');
        this.write(OTHER, OTHER_TEXT);
        git(this.root, 'add -A');
        git(this.root, 'commit -q -m base');
        for (const key of ['NX_BASE', 'NX_HEAD', 'GITHUB_HEAD_REF', 'GITHUB_EVENT_NAME', 'WEBPIECES_BRANCH']) {
            this.savedEnv.set(key, process.env[key]);
            delete process.env[key];
        }
        process.env['NX_BASE'] = git(this.root, 'rev-parse HEAD');
    }

    write(rel: string, text: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, rel)), { recursive: true });
        fs.writeFileSync(path.join(this.root, rel), text);
    }

    /** Owner files must be tracked, so each rewrite is staged exactly as a developer's would be. */
    configure(entry: RuleEntry | null): void {
        this.write(OWNER_FILE, JSON.stringify(entry === null ? {} : { [RULE]: entry }, null, 2));
        if (fs.existsSync(path.join(this.root, '.git'))) git(this.root, `add -- ${OWNER_FILE}`);
    }

    load(): LoadedConfig {
        return loadAndValidate(this.root);
    }

    /** The Write/Edit source guard, end to end: owner config, real module transport, the hook evaluation. */
    guard(rel: string, tool: ToolKind, edits: readonly NormalizedEdit[]): string[] {
        const loaded = this.load();
        const blocked: BlockedResult | null = new HookFileEvaluation().evaluate(
            tool, new NormalizedToolInput(path.join(this.root, rel), edits), loaded, new SourceHookRules().load(loaded));
        if (blocked === null) return [];
        return blocked.report.split('\n').filter((line: string) => /^\s*L\d+:/.test(line))
            .map((line: string) => `${rel}:${/L(\d+):/.exec(line)![1]}`);
    }

    /** The build gate, end to end: the generic pack runner `validate-code` runs inside `wp-build`. */
    async gateSucceeds(): Promise<boolean> {
        const runner = await import(PACK_BUILD_RUNNER);
        return (await new runner.PackBuildRunner().run(this.root, this.load())).success as boolean;
    }

    /** The gate's sites, from the one RuleFailError its build policy throws. */
    async gateSites(): Promise<string[]> {
        const loaded = this.load();
        const policies = await this.pack.buildRuleRuntime.create(
            new PolicyRuntimeRequest(this.root, loaded.rulesConfig as Record<string, ConfigObject>, [RULE], loaded.excludePaths.paths));
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the gate's verdict
        try {
            await policies[0]!.run(this.root);
            return [];
        } catch (err: unknown) {
            //const error = toError(err);
            if (!(err instanceof RuleFailError)) throw err;
            return err.humanMessage.split('\n').filter((line: string) => /^\s+\S+:\d+ — /.test(line))
                .map((line: string) => line.trim().split(' — ')[0]!);
        }
    }

    /** `wp-validate-code --rule=… --mode=… --projects=…`: the bin's composition root, end to end. */
    async debugRun(mode: string | undefined, projects?: string): Promise<boolean> {
        const request = new RunRequestParser().parse(RULE, mode, projects);
        return (await new CodeRulesBootstrap().run(this.root, request)).success;
    }

    dispose(): void {
        for (const entry of this.savedEnv) {
            if (entry[1] === undefined) delete process.env[entry[0]];
            else process.env[entry[0]] = entry[1];
        }
        delete (globalThis as Record<string, LocalRulePack>)[FIXTURE_GLOBAL];
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

describe('repo-local rule packs (#1314): one LocalRule, run by the Write/Edit guard AND the build gate', () => {
    let repo: ConsumerRepo;

    beforeEach(() => {
        repo = new ConsumerRepo();
    });

    afterEach(() => {
        repo.dispose();
        vi.restoreAllMocks();
    });

    it('is a sixth owner in the catalog: owned, schema-validated, seeded, and refused when its entry is missing', () => {
        const registry = repo.load().ruleRegistry;
        expect(registry.ownerOf(RULE)).toBe('local-rules');
        expect(Object.keys(registry.schemaFor(RULE)).sort()).toEqual(
            ['excludePaths', 'methods', 'mode', 'reason', 'turnOffRuleUntilEpoch', 'turnOffRuleWhileOnBranch']);
        expect(registry.seedFor(RULE)).toEqual({ mode: 'NEW_AND_MODIFIED_CODE', methods: ['log'], turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null });
        expect(registry.sectionFor(RULE)).toBe('rules');

        // NO DEFAULTS: a missing entry fails the load, naming the owner file and the seed to paste...
        repo.configure(null);
        expect(() => repo.load()).toThrow(ConfigRepairError);
        expect(() => repo.load()).toThrow(new RegExp(`${OWNER_FILE.replace(/\./g, '\\.')}[\\s\\S]*${RULE}`));
        // ...and so does a missing required setting.
        const entry = new RuleEntry();
        entry.methods = undefined;
        repo.configure(entry);
        expect(() => repo.load()).toThrow(/methods is required/);
    });

    it('reports the same sites in the guard and at the gate for a newly written file, honouring disables', async () => {
        const viaGuard = repo.guard(FRESH, 'Write', [new NormalizedEdit('', FRESH_TEXT, false)]);
        repo.write(FRESH, FRESH_TEXT);
        const viaGate = await repo.gateSites();

        // a() is refused; b() calls an unbanned method; c() carries a disable with a reason; d()'s disable
        // has no reason, so it does not exempt the site.
        expect(viaGuard.sort()).toEqual([`${FRESH}:10`, `${FRESH}:2`]);
        expect(viaGate.sort()).toEqual(viaGuard.sort());
    });

    it('under NEW_AND_MODIFIED_CODE judges only the changed lines of an existing file, in both runners', async () => {
        const viaGuard = repo.guard(LEGACY, 'Edit', [new NormalizedEdit(LEGACY_OLD, LEGACY_NEW, false)]);
        repo.write(LEGACY, LEGACY_TEXT.replace(LEGACY_OLD, LEGACY_NEW));
        const viaGate = await repo.gateSites();

        expect(viaGuard).toEqual([`${LEGACY}:3`]);
        expect(viaGate).toEqual(viaGuard);

        // A whole-file mode judges the grandfathered line too.
        const whole = new RuleEntry();
        whole.mode = 'NEW_AND_MODIFIED_FILES';
        repo.configure(whole);
        expect((await repo.gateSites()).sort()).toEqual([`${LEGACY}:2`, `${LEGACY}:3`]);
    });

    it('fails the real build runner on a violation and passes once it is fixed', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        repo.write(FRESH, 'export const x = (): void => console.log("x");\n');
        expect(await repo.gateSucceeds()).toBe(false);
        expect(errors.mock.calls.flat().join('\n')).toContain(`${FRESH}:1 — console.log() is banned here.`);

        repo.write(FRESH, 'export const x = (): number => 1;\n');
        expect(await repo.gateSucceeds()).toBe(true);
    });

    it('honours mode OFF, the epoch switch and the branch switch in both runners', async () => {
        const write = [new NormalizedEdit('', FRESH_TEXT, false)];
        repo.write(FRESH, FRESH_TEXT);

        const off = new RuleEntry();
        off.mode = 'OFF';
        repo.configure(off);
        expect(repo.guard(FRESH, 'Write', write)).toEqual([]);
        expect(await repo.gateSucceeds()).toBe(true);

        const epoch = new RuleEntry();
        epoch.turnOffRuleUntilEpoch = Math.floor(Date.now() / 1000) + 3600;
        repo.configure(epoch);
        expect(repo.guard(FRESH, 'Write', write)).toEqual([]);
        expect(await repo.gateSucceeds()).toBe(true);

        process.env['WEBPIECES_BRANCH'] = 'dean/local-rule-hatch';
        const branch = new RuleEntry();
        branch.turnOffRuleWhileOnBranch = 'dean/local-rule-hatch';
        repo.configure(branch);
        expect(repo.guard(FRESH, 'Write', write)).toEqual([]);
        expect(await repo.gateSucceeds()).toBe(true);

        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        repo.configure(new RuleEntry());
        expect(repo.guard(FRESH, 'Write', write)).not.toEqual([]);
        expect(await repo.gateSucceeds()).toBe(false);
    });

    it('applies the rule\'s own excludePaths in both runners', async () => {
        const excluded = new RuleEntry();
        excluded.excludePaths = ['src/**'];
        repo.configure(excluded);
        repo.write(FRESH, FRESH_TEXT);
        expect(repo.guard(FRESH, 'Write', [new NormalizedEdit('', FRESH_TEXT, false)])).toEqual([]);
        expect(await repo.gateSites()).toEqual([]);
    });

    it('refuses a rule that redeclares a framework-owned setting or is not kebab-case', () => {
        class Shadowing extends NoBannedConsoleRule {
            override readonly settings = { methods: FieldDef.nonEmptyStrings(), excludePaths: new FieldDef('string[]') };
        }
        class BadId extends NoBannedConsoleRule {
            override readonly id = 'NoBannedConsole';
        }
        expect(() => new LocalRulePack('local-rules', repo.root, [new Shadowing()])).toThrow(/framework-owned setting "excludePaths"/);
        expect(() => new LocalRulePack('local-rules', repo.root, [new BadId()])).toThrow(/must be kebab-case/);
    });
});


describe('the one-rule debug run (#1330) runs a repo-local rule like a built-in one', () => {
    let repo: ConsumerRepo;
    let out: string[];

    beforeEach(() => {
        repo = new ConsumerRepo();
        out = [];
        const capture = (...args: unknown[]): void => {
            out.push(args.map(String).join(' '));
        };
        vi.spyOn(console, 'log').mockImplementation(capture);
        vi.spyOn(console, 'error').mockImplementation(capture);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        repo.dispose();
    });

    it('at RUN_EVERY_TIME finds every committed site with an EMPTY diff, prints the rule\'s own text and a count per project', async () => {
        const configBefore = fs.readFileSync(path.join(repo.root, OWNER_FILE), 'utf-8');
        // The gate judges the diff, which is empty: nothing to report.
        expect(await repo.gateSucceeds()).toBe(true);

        expect(await repo.debugRun('RUN_EVERY_TIME')).toBe(false);

        const text = out.join('\n');
        expect(text).toContain(`DEBUG RUN of ${RULE}`);
        expect(text).toContain('Mode: RUN_EVERY_TIME (committed: NEW_AND_MODIFIED_CODE)');
        expect(text).toContain(`${LEGACY}:2 — console.log() is banned here.`);
        expect(text).toContain(`${OTHER}:1 — console.log() is banned here.`);
        expect(text).toContain(`${RULE} at RUN_EVERY_TIME: 2 site(s) left`);
        expect(text).toContain('   app: 1');
        expect(text).toContain('   other: 1');
        expect(fs.readFileSync(path.join(repo.root, OWNER_FILE), 'utf-8')).toBe(configBefore);
    });

    it('--projects restricts the files judged and the counts printed', async () => {
        expect(await repo.debugRun('RUN_EVERY_TIME', 'other')).toBe(false);
        const text = out.join('\n');
        expect(text).toContain(`${OTHER}:1`);
        expect(text).not.toContain(`${LEGACY}:2`);
        expect(text).toContain(`${RULE} at RUN_EVERY_TIME: 1 site(s) left`);
        expect(text).not.toContain('   app:');
    });

    it('honours per-site disables and the rule\'s excludePaths, and passes once nothing is left', async () => {
        repo.write(FRESH, FRESH_TEXT);
        expect(await repo.debugRun('RUN_EVERY_TIME', 'app')).toBe(false);
        // Legacy's one site plus Fresh's a() and d(): c() carries a disable with a reason, d()'s has none.
        expect(out.join('\n')).toContain(`${RULE} at RUN_EVERY_TIME: 3 site(s) left`);
        expect(out.join('\n')).not.toContain(`${FRESH}:6`);

        const excluded = new RuleEntry();
        excluded.excludePaths = ['src/**'];
        repo.configure(excluded);
        out.length = 0;
        expect(await repo.debugRun('RUN_EVERY_TIME', 'app')).toBe(true);
        expect(out.join('\n')).toContain(`${RULE} at RUN_EVERY_TIME: 0 site(s) left`);
    });

    it('ignores the escape hatches, and refuses a committed OFF without --mode', async () => {
        const epoch = new RuleEntry();
        epoch.turnOffRuleUntilEpoch = Math.floor(Date.now() / 1000) + 3600;
        repo.configure(epoch);
        expect(await repo.debugRun('RUN_EVERY_TIME')).toBe(false);

        const off = new RuleEntry();
        off.mode = 'OFF';
        repo.configure(off);
        await expect(repo.debugRun(undefined)).rejects.toThrow(InformAiError);
        await expect(repo.debugRun(undefined)).rejects.toThrow('its committed mode is OFF');
        await expect(repo.debugRun('SOMETIMES')).rejects.toThrow('--mode=SOMETIMES is not one of its modes');
        await expect(repo.debugRun('RUN_EVERY_TIME', 'nope')).rejects.toThrow('no such nx project: nope');
    });

    it('a delete-only change: the diff modes have nothing to judge, RUN_EVERY_TIME still judges the repo', async () => {
        git(repo.root, `rm -q -- ${OTHER}`);
        expect(await repo.gateSucceeds()).toBe(true);

        expect(await repo.debugRun('RUN_EVERY_TIME')).toBe(false);
        expect(out.join('\n')).toContain(`${RULE} at RUN_EVERY_TIME: 1 site(s) left`);
    });

    it('an unknown rule is refused with a list that names the local rules too', async () => {
        const request = new RunRequestParser().parse('no-such-rule', 'RUN_EVERY_TIME', undefined);
        await expect(new CodeRulesBootstrap().run(repo.root, request)).rejects.toThrow(
            new RegExp(`no-such-rule is not a rule that supports a debug run[\\s\\S]*no-any-unknown[\\s\\S]*${RULE}`),
        );
    });
});
