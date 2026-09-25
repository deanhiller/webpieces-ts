import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    CONFIG_FILENAME,
    DiffScope,
    InformAiError,
    ModifiedCodeMode,
    NoDestructureConfig,
    OneEnumSpellingInApiLibConfig,
    RuleFailError,
    allRuleNames,
    sectionForRule,
    seedEntryForRule,
    specTempDirs,
} from '@webpieces/rules-config';

import { CodeRulesBootstrap } from './code-rules-bootstrap';
import { CodeRulesRunRequest, RunRequestParser } from './code-rules-run-request';
import { ProjectCatalog, ScanRestriction, ScanScope } from './scan-scope';
import { ProjectRoleResolver } from './project-role-resolver';
import { OneEnumSpellingInApiLibValidator } from './validate-one-enum-spelling-in-api-lib';
import { NoDestructureValidator } from './validate-no-destructure';

/**
 * #1027 — the whole-scope modes (MODIFIED_PROJECTS, RUN_EVERY_TIME) on the diff-scoped code rules, and
 * the per-run DEBUG override (`--rule` / `--mode` / `--projects`) that needs no config edit.
 *
 * Every case runs in a throwaway git repo whose base commit already holds violations NOT in the diff —
 * the "what is left?" sites a rule adopted at NEW_AND_MODIFIED_CODE grandfathers. The diff then touches
 * ONE project (`lang-apis`) with a clean file.
 */

/** Old, grandfathered violations — committed on the base, so never in the diff. */
const OLD_UNION = "export type Old = 'a' | 'b';\n";
const OLD_DESTRUCTURE = 'export class Util {\n    run(p: { a: number }): number {\n        const { a } = p;\n        return a;\n    }\n}\n';

class Repo {
    readonly root = specTempDirs.makeReal('wp-whole-scope-');

    constructor() {
        this.git('init -q -b main');
        this.git('config user.email t@t.t');
        this.git('config user.name t');
        this.project('libs/apis', 'lang-apis', 'role:api-lib');
        this.project('libs/other', 'other-apis', 'role:api-lib');
        this.project('libs/util', 'util', 'role:lib');
        this.write('libs/apis/src/Old.ts', OLD_UNION);
        this.write('libs/other/src/Other.ts', OLD_UNION);
        this.write('libs/util/src/Util.ts', OLD_DESTRUCTURE);
        this.git('add -A');
        this.git('commit -q -m base');
        process.env['NX_BASE'] = this.git('rev-parse HEAD').trim();
        // The diff: one clean file in lang-apis — the project is TOUCHED, its Old.ts is not.
        this.write('libs/apis/src/Touched.ts', 'export const touched = 1;\n');
    }

    write(relPath: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relPath), content);
    }

    /** A webpieces.config.json that validates: every rule OFF except the ones given. */
    // webpieces-disable no-any-unknown -- raw config JSON is an opaque option bag, exactly as consumers write it
    config(overrides: Record<string, Record<string, unknown>>): void {
        // webpieces-disable no-any-unknown -- opaque option bags
        const rules: Record<string, unknown> = {};
        // webpieces-disable no-any-unknown -- opaque option bags
        const hookGuards: Record<string, unknown> = {};
        for (const name of allRuleNames()) {
            const entry = { ...seedEntryForRule(name), mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };
            const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
            target[name] = overrides[name] ? { ...entry, ...overrides[name] } : entry;
        }
        this.write(CONFIG_FILENAME, JSON.stringify({
            rules,
            hookGuards,
            commands: { 'pr-gate': { mode: 'ON', buildCommand: 'echo ci', mergeMode: 'AUTO', reviewerAgents: 1 } },
            excludePaths: [],
            'match-rules': [],
        }));
    }

    dispose(): void {
        delete process.env['NX_BASE'];
        fs.rmSync(this.root, { recursive: true, force: true });
    }

    private project(dir: string, name: string, role: string): void {
        this.write(`${dir}/project.json`, JSON.stringify({ name, tags: [role] }));
    }

    private git(args: string): string {
        return execSync(`git ${args}`, { cwd: this.root, encoding: 'utf-8' });
    }
}

function scanScope(projects?: string[]): ScanScope {
    const diffScope = new DiffScope();
    return new ScanScope(diffScope, new ProjectCatalog(diffScope), new ScanRestriction(projects));
}

function enumRule(mode: ModifiedCodeMode, scan: ScanScope = scanScope()): OneEnumSpellingInApiLibValidator {
    const config = new OneEnumSpellingInApiLibConfig();
    config.mode = mode;
    return new OneEnumSpellingInApiLibValidator(config, new ProjectRoleResolver(), new DiffScope(), scan);
}

function destructureRule(mode: ModifiedCodeMode): NoDestructureValidator {
    const config = new NoDestructureConfig();
    config.mode = mode;
    config.turnOffRuleUntilEpoch = 0;
    return new NoDestructureValidator(config, scanScope());
}

/** The files a failing enum run named, or [] when it passed. */
async function enumFailures(rule: OneEnumSpellingInApiLibValidator, root: string): Promise<string[]> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this helper returns
    try {
        await rule.run(root);
        return [];
    } catch (err: unknown) {
        //const error = toError(err);
        if (!(err instanceof RuleFailError)) throw err;
        return err.fixOptions.map((o: { text: string }) => o.text.split(':')[0]!).sort();
    }
}

describe('whole-scope modes (#1027): a violating file NOT in the diff', () => {
    let repo: Repo;
    beforeEach(() => {
        repo = new Repo();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        repo.dispose();
    });

    it('PASSES under both NEW_AND_MODIFIED_* modes — it is grandfathered', async () => {
        expect(await enumFailures(enumRule('NEW_AND_MODIFIED_CODE'), repo.root)).toEqual([]);
        expect(await enumFailures(enumRule('NEW_AND_MODIFIED_FILES'), repo.root)).toEqual([]);
    });

    it('FAILS under MODIFIED_PROJECTS when its project is touched — and only then', async () => {
        expect(await enumFailures(enumRule('MODIFIED_PROJECTS'), repo.root)).toEqual(['libs/apis/src/Old.ts']);
    });

    it('FAILS under RUN_EVERY_TIME wherever it is in the repo', async () => {
        expect(await enumFailures(enumRule('RUN_EVERY_TIME'), repo.root))
            .toEqual(['libs/apis/src/Old.ts', 'libs/other/src/Other.ts']);
    });

    it('holds for a rule outside the api-lib family too (no-destructure)', async () => {
        expect((await destructureRule('NEW_AND_MODIFIED_FILES').run(repo.root)).success).toBe(true);
        expect((await destructureRule('MODIFIED_PROJECTS').run(repo.root)).success).toBe(true); // util untouched
        expect((await destructureRule('RUN_EVERY_TIME').run(repo.root)).success).toBe(false);
        repo.write('libs/util/README.md', 'touch the project with a non-ts file\n');
        expect((await destructureRule('MODIFIED_PROJECTS').run(repo.root)).success).toBe(false);
    });

    it('a --projects restriction narrows every mode to those projects, and counts per project', async () => {
        const scan = scanScope(['other-apis']);
        expect(await enumFailures(enumRule('RUN_EVERY_TIME', scan), repo.root)).toEqual(['libs/other/src/Other.ts']);
        expect(Array.from(scan.countsByProject(repo.root).entries())).toEqual([['other-apis', 1]]);
    });
});

describe('the DEBUG run (#1027): --rule / --mode / --projects, no config edit', () => {
    let repo: Repo;
    let out: string[];
    beforeEach(() => {
        repo = new Repo();
        repo.config({ 'one-enum-spelling-in-api-lib': { mode: 'NEW_AND_MODIFIED_CODE' } });
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

    function debug(rule: string | undefined, mode: string | undefined, projects: string | undefined): CodeRulesRunRequest {
        return new RunRequestParser().parse(rule, mode, projects);
    }

    it('reports ONLY the named projects\' sites with the rule\'s own text, and exits non-zero', async () => {
        const configBefore = fs.readFileSync(path.join(repo.root, CONFIG_FILENAME), 'utf-8');

        const result = await new CodeRulesBootstrap().run(repo.root, debug('one-enum-spelling-in-api-lib', 'RUN_EVERY_TIME', 'other-apis'));

        const text = out.join('\n');
        expect(result.success).toBe(false);
        expect(text).toContain('DEBUG RUN of one-enum-spelling-in-api-lib');
        expect(text).toContain('libs/other/src/Other.ts:1'); // the rule's OWN failure text
        expect(text).toContain('export enum'); // …including its cure
        expect(text).not.toContain('libs/apis/src/Old.ts');
        expect(text).toContain('   other-apis: 1');
        expect(fs.readFileSync(path.join(repo.root, CONFIG_FILENAME), 'utf-8')).toBe(configBefore); // nothing on disk
    });

    it('without --mode it uses the COMMITTED mode, scoped to --projects', async () => {
        const result = await new CodeRulesBootstrap().run(repo.root, debug('one-enum-spelling-in-api-lib', undefined, 'lang-apis,other-apis'));

        expect(result.success).toBe(true);
        expect(out.join('\n')).toContain('Mode: NEW_AND_MODIFIED_CODE (committed: NEW_AND_MODIFIED_CODE)');
        expect(out.join('\n')).toContain('   lang-apis: 0');
    });

    it('the gate (no debug flags) keeps honouring the committed mode', async () => {
        expect((await new CodeRulesBootstrap().run(repo.root, debug(undefined, undefined, undefined))).success).toBe(true);
    });

    it('THROWS an InformAiError for an unknown project, a rule without the whole-scope modes, and flags without --rule', async () => {
        await expect(new CodeRulesBootstrap().run(repo.root, debug('one-enum-spelling-in-api-lib', 'RUN_EVERY_TIME', 'nope')))
            .rejects.toThrow(InformAiError);
        await expect(new CodeRulesBootstrap().run(repo.root, debug('one-enum-spelling-in-api-lib', 'RUN_EVERY_TIME', 'nope')))
            .rejects.toThrow('no such nx project: nope');
        await expect(new CodeRulesBootstrap().run(repo.root, debug('max-method-lines', 'RUN_EVERY_TIME', undefined)))
            .rejects.toThrow('is not a code rule that supports a debug run');
        await expect(new CodeRulesBootstrap().run(repo.root, debug(undefined, 'RUN_EVERY_TIME', undefined)))
            .rejects.toThrow('need --rule=<name>');
    });
});
