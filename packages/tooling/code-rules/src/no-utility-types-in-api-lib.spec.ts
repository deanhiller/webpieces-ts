import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { DiffScope, NoUtilityTypesInApiLibConfig, RuleFailError, specTempDirs } from '@webpieces/rules-config';

import { ApiLibFile, ApiLibSite } from './api-lib-source-rule';
import { NoUtilityTypesInApiLibValidator, UtilityTypeScanner } from './validate-no-utility-types-in-api-lib';
import { ProjectRoleResolver } from './project-role-resolver';
import { GateScanScope } from './scan-scope';

/**
 * `no-utility-types-in-api-lib` (#1026): every refused shape, the cure each prints, the allowed
 * spellings passing, then the validator end to end in a throwaway git repo so the `paths` scoping,
 * the modes and the disable hatch are real.
 */

class Source {
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static sites(text: string): ApiLibSite[] {
        const file = new ApiLibFile('libraries/apis/x/src/Dtos.ts',
            ts.createSourceFile('Dtos.ts', text, ts.ScriptTarget.Latest, true), '/nowhere');
        return new UtilityTypeScanner().scan(file);
    }
}

describe('no-utility-types-in-api-lib — the scanner', () => {
    it('refuses `interface X extends Omit<…>`, naming the interface and printing the write-the-fields-out cure', () => {
        const sites = Source.sites([
            "type CourseOptionalLessonField = 'wordRule' | 'lessonJson';",
            'export interface LessonPassageDto',
            '    extends Omit<LessonPassageReservationDto, CourseOptionalLessonField> {',
            '    wordRule?: string;',
            '}',
        ].join('\n'));

        expect(sites).toHaveLength(1);
        expect(sites[0]!.line).toBe(3);
        expect(sites[0]!.what).toContain('`Omit<…>`');
        expect(sites[0]!.cure).toContain('instead of `Omit<LessonPassageReservationDto, CourseOptionalLessonField>`');
        expect(sites[0]!.cure).toContain('base interface');
        expect(sites[0]!.cure).toContain('flat interface or class');
        expect(sites[0]!.cure).toContain('The wire JSON is unchanged.');
        expect(sites[0]!.cure).toContain('(on interface LessonPassageDto)');
    });

    it('refuses Omit as a field type, an alias and a generic argument', () => {
        const sites = Source.sites([
            'export type Slim = Omit<Full, \'secret\'>;',
            'export class Holder {',
            '    item?: Omit<Full, \'secret\'>;',
            '    items: Array<Omit<Full, \'secret\'>> = [];',
            '}',
        ].join('\n'));

        expect(sites.map((s: ApiLibSite) => s.line)).toEqual([1, 3, 4]);
        expect(sites[0]!.cure).toContain('(in type Slim)');
        expect(sites[1]!.cure).toContain('(in class Holder.item)');
    });

    it('refuses the rest of the family: Pick, Partial, Required, Exclude, Extract', () => {
        const sites = Source.sites([
            "export type A = Pick<Full, 'id'>;",
            'export type B = Partial<Full>;',
            'export type C = Required<Full>;',
            "export type D = Exclude<Kind, 'legacy'>;",
            "export type E = Extract<Kind, 'audio'>;",
            'export interface F extends Partial<Full> { extra: string; }',
        ].join('\n'));

        expect(sites.map((s: ApiLibSite) => s.what.split('`')[1])).toEqual([
            'Pick<…>', 'Partial<…>', 'Required<…>', 'Exclude<…>', 'Extract<…>', 'Partial<…>',
        ]);
        expect(sites[1]!.cure).toContain('as optional (`field?: X`)');
        expect(sites[3]!.cure).toContain('one-enum-spelling-in-api-lib');
    });

    it('reports each utility of a nested computation', () => {
        const sites = Source.sites("export type A = Pick<Full, Exclude<keyof Full, 'secret'>>;");

        expect(sites.map((s: ApiLibSite) => s.what.split('`')[1])).toEqual(['Pick<…>', 'Exclude<…>']);
    });

    it('ALLOWS plain interfaces and classes, extending a normal base, Record, Readonly and Array', () => {
        expect(Source.sites([
            'export interface Base { id: string; }',
            'export interface Child extends Base { name?: string; }',
            'export class Dto implements Child {',
            '    id!: string;',
            '    tags: Record<string, string> = {};',
            '    frozen?: Readonly<Base>;',
            '    list: Array<Base> = [];',
            '}',
        ].join('\n'))).toEqual([]);
    });

    it('does not refuse a name the file declares or imports itself', () => {
        expect(Source.sites([
            "import { Pick } from './tools';",
            'type Omit<T> = { value: T };',
            'export class Dto { a?: Omit<string>; b?: Pick<string>; }',
        ].join('\n'))).toEqual([]);
    });
});

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

class Repo {
    readonly root = specTempDirs.makeReal('no-utility-types-');

    constructor() {
        git(this.root, 'init -q -b main');
        git(this.root, 'config user.email test@test.com');
        git(this.root, 'config user.name test');
        this.write('placeholder.txt', 'x\n');
        this.write('libraries/apis/lessons/src/Old.ts', "export type Old = Omit<Full, 'id'>;\n");
        git(this.root, 'add -A');
        git(this.root, 'commit -q -m base');
        process.env['NX_BASE'] = git(this.root, 'rev-parse HEAD');
        delete process.env['NX_HEAD'];
    }

    write(relPath: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relPath), content);
    }

    dispose(): void {
        delete process.env['NX_BASE'];
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

/** The failure a run threw, or undefined when it passed. The catch IS the assertion. */
async function failureOf(run: () => Promise<unknown>): Promise<RuleFailError | undefined> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this helper returns
    try {
        await run();
        return undefined;
    } catch (err: unknown) {
        //const error = toError(err);
        if (err instanceof RuleFailError) return err;
        throw err;
    }
}

function rule(
    mode: 'NEW_AND_MODIFIED_CODE' | 'NEW_AND_MODIFIED_FILES' | 'OFF',
    paths: string[] = ['libraries/apis/**'],
    allowedPaths?: string[],
): NoUtilityTypesInApiLibValidator {
    const config = new NoUtilityTypesInApiLibConfig();
    config.mode = mode;
    config.paths = paths;
    config.allowedPaths = allowedPaths;
    return new NoUtilityTypesInApiLibValidator(config, new ProjectRoleResolver(), new DiffScope(), new GateScanScope());
}

describe('no-utility-types-in-api-lib — the validator, end to end', () => {
    let repo: Repo;

    beforeEach(() => {
        repo = new Repo();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('THROWS a RuleFailError naming the file:line, with one Option per site', async () => {
        repo.write('libraries/apis/lessons/src/Dtos.ts',
            "export interface Slim extends Omit<Full, 'secret'> {\n    extra?: Partial<Full>;\n}\n");

        const failure = await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root));

        expect(failure?.ruleName).toBe('no-utility-types-in-api-lib');
        expect(failure?.humanMessage).toContain('an API contract library (paths: libraries/apis/**)');
        expect(failure?.humanMessage).toContain('libraries/apis/lessons/src/Dtos.ts:1');
        expect(failure?.humanMessage).toContain('libraries/apis/lessons/src/Dtos.ts:2');
        expect(failure?.fixOptions.map((o: { text: string }) => o.text)).toEqual([
            expect.stringContaining("instead of `Omit<Full, 'secret'>`"),
            expect.stringContaining('instead of `Partial<Full>`'),
        ]);
    });

    it('judges ONLY files under `paths`, and nothing at all when `paths` is empty', async () => {
        repo.write('libraries/util/src/Dtos.ts', "export type Slim = Omit<Full, 'secret'>;\n");
        expect(await failureOf(() => rule('NEW_AND_MODIFIED_FILES').run(repo.root))).toBeUndefined();

        repo.write('libraries/apis/lessons/src/Dtos.ts', "export type Slim = Omit<Full, 'secret'>;\n");
        expect(await failureOf(() => rule('NEW_AND_MODIFIED_FILES', []).run(repo.root))).toBeUndefined();
        expect(await failureOf(() => rule('NEW_AND_MODIFIED_FILES', ['libraries/util/**']).run(repo.root)))
            .toBeInstanceOf(RuleFailError);
    });

    it('exempts `allowedPaths` and spec files', async () => {
        repo.write('libraries/apis/lessons/src/Dtos.spec.ts', "export type Slim = Omit<Full, 'secret'>;\n");
        repo.write('libraries/apis/legacy/src/Dtos.ts', "export type Slim = Omit<Full, 'secret'>;\n");

        expect(await failureOf(() => rule('NEW_AND_MODIFIED_FILES', ['libraries/apis/**'], ['libraries/apis/legacy/**'])
            .run(repo.root))).toBeUndefined();
    });

    it('NEW_AND_MODIFIED_CODE grandfathers unchanged lines; NEW_AND_MODIFIED_FILES judges the whole changed file', async () => {
        repo.write('libraries/apis/lessons/src/Old.ts', "export type Old = Omit<Full, 'id'>;\nexport const touched = 1;\n");

        expect(await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root))).toBeUndefined();
        expect((await failureOf(() => rule('NEW_AND_MODIFIED_FILES').run(repo.root)))?.humanMessage)
            .toContain('libraries/apis/lessons/src/Old.ts:1');
    });

    it('NEW_AND_MODIFIED_CODE judges a CHANGED line of an existing file', async () => {
        repo.write('libraries/apis/lessons/src/Old.ts', "export type Old = Pick<Full, 'id'>;\n");

        expect((await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root)))?.humanMessage)
            .toContain('libraries/apis/lessons/src/Old.ts:1');
    });

    it('honours a per-site disable and mode OFF', async () => {
        repo.write('libraries/apis/lessons/src/Dtos.ts',
            "// webpieces-disable no-utility-types-in-api-lib -- mirrors a partner schema verbatim\nexport type Slim = Omit<Full, 'secret'>;\n");

        expect(await failureOf(() => rule('NEW_AND_MODIFIED_CODE').run(repo.root))).toBeUndefined();
        repo.write('libraries/apis/lessons/src/More.ts', 'export type More = Partial<Full>;\n');
        expect(await failureOf(() => rule('OFF').run(repo.root))).toBeUndefined();
    });
});
