import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    DiffScope,
    RequiredTypeSuffixConfig,
    RequiredTypeSuffixEntry,
    RuleFailError,
    specTempDirs,
    toError,
} from '@webpieces/rules-config';

import { ApiLibFile, ApiLibSite } from './api-lib-source-rule';
import { ProjectRoleResolver } from './project-role-resolver';
import { GateScanScope } from './scan-scope';
import {
    ExportedTypeScanner,
    RequiredTypeSuffixValidator,
    SuffixEntryPicker,
    SuffixRename,
} from './validate-required-type-suffix';

/**
 * `required-type-suffix` (#1037): which declarations are judged, the suffix match, the rename each failure
 * prints, which entry governs an overlapping path (the first match in config order), then the validator end to end in a throwaway git repo
 * so the modes (including RUN_EVERY_TIME through the same planner the engine uses) are real.
 */

const API_SUFFIXES = ['Request', 'Response', 'Event', 'Dto', 'Api'];

class Entries {
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static of(paths: string[], suffixes: string[]): RequiredTypeSuffixEntry {
        const entry = new RequiredTypeSuffixEntry();
        entry.paths = paths;
        entry.suffixes = suffixes;
        return entry;
    }

    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static issueExample(): RequiredTypeSuffixEntry[] {
        return [
            Entries.of(['libraries/apis/internal/**'], API_SUFFIXES),
            Entries.of(['libraries/browser-node/fs-*-model/**'], ['Fs']),
        ];
    }
}

class Source {
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static sites(text: string, suffixes: string[] = API_SUFFIXES): ApiLibSite[] {
        const file = new ApiLibFile('libraries/apis/internal/x/src/Dtos.ts',
            ts.createSourceFile('Dtos.ts', text, ts.ScriptTarget.Latest, true), '/nowhere');
        return new ExportedTypeScanner().scan(file, Entries.of(['libraries/apis/internal/**'], suffixes), 'libraries/apis/internal/**');
    }
}

describe('required-type-suffix — the scanner', () => {
    it('refuses an exported interface, class, abstract class, enum and type alias with a bad suffix', () => {
        const sites = Source.sites([
            'export interface TopNamePlaceInput { name: string; }',
            'export class AdminVoiceSampleRow { id!: string; }',
            'export abstract class StoryVoiceOption { }',
            "export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }",
            "export type CourseSpeakerGender = 'female' | 'male';",
        ].join('\n'));

        expect(sites.map((s: ApiLibSite) => s.line)).toEqual([1, 2, 3, 4, 5]);
        expect(sites.map((s: ApiLibSite) => s.what.split(' `')[0])).toEqual([
            'exported interface', 'exported class', 'exported class', 'exported enum', 'exported type',
        ]);
        expect(sites[0]!.what).toContain('`TopNamePlaceInput`');
        expect(sites[0]!.what).toContain('libraries/apis/internal/** (Request | Response | Event | Dto | Api)');
    });

    it('prints the cure: the suggested rename, the other candidates, the allowed suffixes, and why', () => {
        const cure = Source.sites('export interface TopNamePlaceInput { name: string; }')[0]!.cure;

        expect(cure).toContain('rename interface `TopNamePlaceInput` → `TopNamePlaceRequest`');
        expect(cure).toContain('`TopNamePlaceDto`');
        expect(cure).toContain('…Request for an endpoint body');
        expect(cure).toContain('update every reference');
        expect(cure).toContain('Allowed suffixes under libraries/apis/internal/**: Request | Response | Event | Dto | Api');
        expect(cure).toContain('the suffix tells a reader which layer the type belongs to');
    });

    it('passes the same kinds of types with an allowed suffix', () => {
        expect(Source.sites([
            'export interface TopNamePlaceRequest { name: string; }',
            'export class AdminVoiceSampleResponse { id!: string; }',
            'export abstract class StoryVoiceEvent { }',
            "export enum SpeakerGenderDto { FEMALE = 'female', MALE = 'male' }",
            'export type LessonApi = { get(): void };',
        ].join('\n'))).toEqual([]);
    });

    it('does not judge a non-exported type, nor an exported const (a DI token holder is not a type)', () => {
        expect(Source.sites([
            'interface LocalShape { a: string; }',
            'class LocalHelper { }',
            "type LocalKind = 'a' | 'b';",
            "export const LESSON_API = Symbol('LessonApi');",
            'export function helper(): void { }',
        ].join('\n'))).toEqual([]);
    });

    it('matches case-sensitively, and a suffix alone is not a name', () => {
        const sites = Source.sites('export interface FooDTO { a: string; }\nexport interface Dto { b: string; }');

        expect(sites.map((s: ApiLibSite) => s.line)).toEqual([1, 2]);
        expect(sites[0]!.cure).toContain('→ `FooRequest`');
        expect(sites[1]!.cure).toContain('→ `<Name>Request`');
    });

    it('judges a local type exported through an export list by the name it is exported AS', () => {
        const sites = Source.sites([
            'interface Shape { a: string; }',
            'interface Other { b: string; }',
            'export { Shape as ShapeDto, Other };',
        ].join('\n'));

        expect(sites).toHaveLength(1);
        expect(sites[0]!.line).toBe(3);
        expect(sites[0]!.what).toContain('`Other`');
    });

    it('reports a decorated class at the line of its NAME', () => {
        const sites = Source.sites('@Injectable()\nexport class Loose { }');

        expect(sites.map((s: ApiLibSite) => s.line)).toEqual([2]);
    });
});

describe('required-type-suffix — the rename and the governing entry', () => {
    it('drops a layer-less tail before appending the suffix', () => {
        expect(new SuffixRename().candidates('TopNamePlaceInput', ['Dto', 'Request'])).toEqual(['TopNamePlaceDto', 'TopNamePlaceRequest']);
        expect(new SuffixRename().candidates('FixedStoryVoice', ['Fs'])).toEqual(['FixedStoryVoiceFs']);
    });

    it('a narrower entry listed FIRST governs its files; the broader entry governs the rest', () => {
        const narrow = Entries.of(['libraries/apis/internal/**'], ['Fs']);
        const broad = Entries.of(['libraries/apis/**'], ['Dto']);
        const picker = new SuffixEntryPicker();

        expect(picker.entryFor('libraries/apis/internal/x/src/A.ts', [narrow, broad])).toBe(narrow);
        expect(picker.entryFor('libraries/apis/public/x/src/A.ts', [narrow, broad])).toBe(broad);
        expect(picker.entryFor('libraries/util/src/A.ts', [narrow, broad])).toBeUndefined();
    });

    it('the same narrower entry listed AFTER a broader one never applies — the broader one governs', () => {
        const broad = Entries.of(['libraries/apis/**'], ['Dto']);
        const narrow = Entries.of(['libraries/apis/internal/**'], ['Fs']);
        const picker = new SuffixEntryPicker();

        expect(picker.entryFor('libraries/apis/internal/x/src/A.ts', [broad, narrow])).toBe(broad);
        expect(picker.winner('libraries/apis/internal/x/src/A.ts', [broad, narrow])?.glob).toBe('libraries/apis/**');
    });

    it('names the matching glob of the governing entry, not its first glob', () => {
        const entry = Entries.of(['libraries/other/**', 'libraries/apis/**'], ['Dto']);

        expect(new SuffixEntryPicker().winner('libraries/apis/x/src/A.ts', [entry])?.glob).toBe('libraries/apis/**');
    });
});

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

class Repo {
    readonly root = specTempDirs.makeReal('required-type-suffix-');

    constructor() {
        git(this.root, 'init -q -b main');
        git(this.root, 'config user.email test@test.com');
        git(this.root, 'config user.name test');
        // A legacy violation, committed BEFORE the diff.
        this.write('libraries/apis/internal/lessons/src/Legacy.ts',
            'export interface LegacyInput { a: string; }\nexport const touched = 0;\n');
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

/** Runs the rule at `mode` exactly as the gate does, through its unrestricted ScanScope. */
async function failureAt(
    root: string,
    mode: string,
    entries: RequiredTypeSuffixEntry[] = Entries.issueExample(),
    allowedPaths?: string[],
): Promise<RuleFailError | undefined> {
    const committed = new RequiredTypeSuffixConfig();
    committed.mode = mode as RequiredTypeSuffixConfig['mode'];
    committed.entries = entries;
    committed.allowedPaths = allowedPaths;
    const validator = new RequiredTypeSuffixValidator(
        committed,
        new ProjectRoleResolver(),
        new DiffScope(),
        new GateScanScope(),
    );
    // webpieces-disable no-unmanaged-exceptions -- the thrown rule failure is this helper's return value
    try {
        await validator.run(root);
        return undefined;
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) return error;
        throw error;
    }
}

describe('required-type-suffix — the validator, end to end', () => {
    let repo: Repo;

    beforeEach(() => {
        repo = new Repo();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('THROWS a RuleFailError naming file:line, with one Option per site', async () => {
        repo.write('libraries/apis/internal/lessons/src/Dtos.ts',
            'export interface TopNamePlaceInput { a: string; }\nexport interface TopNamePlaceRequest { b: string; }\nexport class Row { }\n');

        const failure = await failureAt(repo.root, 'NEW_AND_MODIFIED_CODE');

        expect(failure?.ruleName).toBe('required-type-suffix');
        expect(failure?.humanMessage).toContain('libraries/apis/internal/lessons/src/Dtos.ts:1');
        expect(failure?.humanMessage).toContain('libraries/apis/internal/lessons/src/Dtos.ts:3');
        expect(failure?.humanMessage).not.toContain('Dtos.ts:2');
        expect(failure?.humanMessage).toContain('the suffix tells a reader which layer a type belongs to');
        expect(failure?.fixOptions.map((o: { text: string }) => o.text)).toEqual([
            expect.stringContaining('libraries/apis/internal/lessons/src/Dtos.ts:1: rename interface `TopNamePlaceInput` → `TopNamePlaceRequest`'),
            expect.stringContaining('libraries/apis/internal/lessons/src/Dtos.ts:3: rename class `Row` → `RowRequest`'),
        ]);
    });

    it('an untouched legacy violation PASSES under NEW_AND_MODIFIED_CODE and FAILS under RUN_EVERY_TIME', async () => {
        repo.write('libraries/apis/internal/lessons/src/Legacy.ts',
            'export interface LegacyInput { a: string; }\nexport const touched = 1;\n');

        expect(await failureAt(repo.root, 'NEW_AND_MODIFIED_CODE')).toBeUndefined();
        expect((await failureAt(repo.root, 'NEW_AND_MODIFIED_FILES'))?.humanMessage).toContain('Legacy.ts:1');
        expect((await failureAt(repo.root, 'RUN_EVERY_TIME'))?.humanMessage).toContain('Legacy.ts:1');
    });

    it('RUN_EVERY_TIME judges the legacy violation even when the diff touches nothing near it', async () => {
        repo.write('README.md', 'x\n');

        expect(await failureAt(repo.root, 'NEW_AND_MODIFIED_FILES')).toBeUndefined();
        expect((await failureAt(repo.root, 'RUN_EVERY_TIME'))?.humanMessage).toContain('Legacy.ts:1');
    });

    it('a RENAMED type is judged under NEW_AND_MODIFIED_CODE', async () => {
        repo.write('libraries/apis/internal/lessons/src/Legacy.ts',
            'export interface LegacyShape { a: string; }\nexport const touched = 0;\n');

        const failure = await failureAt(repo.root, 'NEW_AND_MODIFIED_CODE');
        expect(failure?.humanMessage).toContain('Legacy.ts:1');
        expect(failure?.humanMessage).toContain('`LegacyShape`');

        repo.write('libraries/apis/internal/lessons/src/Legacy.ts',
            'export interface LegacyDto { a: string; }\nexport const touched = 0;\n');
        expect(await failureAt(repo.root, 'NEW_AND_MODIFIED_CODE')).toBeUndefined();
    });

    it('two entries with different suffixes each apply only to their own paths', async () => {
        repo.write('libraries/apis/internal/lessons/src/Wire.ts', 'export interface LessonFs { a: string; }\nexport interface LessonDto { a: string; }\n');
        repo.write('libraries/browser-node/fs-lang-model/src/Doc.ts', 'export interface LessonDto { a: string; }\nexport interface LessonFs { a: string; }\n');
        repo.write('libraries/util/src/Free.ts', 'export interface Anything { a: string; }\n');

        const message = (await failureAt(repo.root, 'NEW_AND_MODIFIED_FILES'))?.humanMessage ?? '';

        expect(message).toContain('libraries/apis/internal/lessons/src/Wire.ts:1');
        expect(message).not.toContain('Wire.ts:2');
        expect(message).toContain('libraries/browser-node/fs-lang-model/src/Doc.ts:1');
        expect(message).not.toContain('Doc.ts:2');
        expect(message).not.toContain('Free.ts');
        expect(message).toContain('(Fs)');
    });

    it('exempts spec files, `allowedPaths`, a per-site disable, and mode OFF', async () => {
        repo.write('libraries/apis/internal/lessons/src/Dtos.spec.ts', 'export interface Fixture { a: string; }\n');
        repo.write('libraries/apis/internal/vendor/src/Mirror.ts', 'export interface Mirror { a: string; }\n');
        repo.write('libraries/apis/internal/lessons/src/Partner.ts',
            '// webpieces-disable required-type-suffix -- mirrors a partner schema name verbatim\nexport interface PartnerShape { a: string; }\n');

        expect(await failureAt(repo.root, 'NEW_AND_MODIFIED_CODE', Entries.issueExample(), ['libraries/apis/internal/vendor/**']))
            .toBeUndefined();
        repo.write('libraries/apis/internal/lessons/src/More.ts', 'export interface More { a: string; }\n');
        expect(await failureAt(repo.root, 'OFF')).toBeUndefined();
    });
});
