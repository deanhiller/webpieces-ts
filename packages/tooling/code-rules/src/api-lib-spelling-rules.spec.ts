import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    DiffScope,
    NoInlineImportInApiLibConfig,
    OneEnumSpellingInApiLibConfig,
    RuleFailError,
    specTempDirs,
} from '@webpieces/rules-config';

import { ApiLibFile, ApiLibSite } from './api-lib-source-rule';
import { ApiLibEnumIndex } from './api-lib-enum-index';
import { EnumText } from './api-lib-enum-text';
import { InlineImportScanner, NoInlineImportInApiLibValidator } from './validate-no-inline-import-in-api-lib';
import { EnumSpellingScanner, OneEnumSpellingInApiLibValidator } from './validate-one-enum-spelling-in-api-lib';
import { ProjectRoleResolver } from './project-role-resolver';
import { GateScanScope } from './scan-scope';

/**
 * The two `role:api-lib` spelling rules (#1023): every refused shape, the cure each prints, and the
 * allowed spellings passing. Scanners are exercised on parsed source; the validators end to end in a
 * throwaway git repo, so the api-lib scoping, the modes and the disable hatch are real.
 */

class Source {
    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static file(text: string): ApiLibFile {
        return new ApiLibFile('libs/apis/src/Dtos.ts', ts.createSourceFile('Dtos.ts', text, ts.ScriptTarget.Latest, true), '/nowhere');
    }

    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static enumSites(text: string): ApiLibSite[] {
        const file = Source.file(text);
        const index = new ApiLibEnumIndex();
        index.add(file.source);
        return new EnumSpellingScanner().scan(file, index);
    }

    // webpieces-disable no-function-outside-class -- static factory of this spec helper
    static importSites(text: string): ApiLibSite[] {
        return new InlineImportScanner().scan(Source.file(text));
    }
}

describe('no-inline-import-in-api-lib — the scanner', () => {
    it('refuses an import() TYPE node, printing the top-of-file import and the rewritten type', () => {
        const sites = Source.importSites(
            "export class Settings {\n    activeAiProvider?: import('@myorg/company-core').AiProvider;\n}\n",
        );

        expect(sites).toHaveLength(1);
        expect(sites[0]!.line).toBe(2);
        expect(sites[0]!.what).toContain('import() TYPE');
        expect(sites[0]!.cure).toContain("import { AiProvider } from '@myorg/company-core';");
        expect(sites[0]!.cure).toContain('write `AiProvider` here');
    });

    it('refuses a dynamic import() EXPRESSION', () => {
        const sites = Source.importSites("export async function load(): Promise<void> {\n    await import('./heavy');\n}\n");

        expect(sites).toHaveLength(1);
        expect(sites[0]!.what).toContain('dynamic import() EXPRESSION');
        expect(sites[0]!.cure).toContain("from './heavy'");
    });

    it('allows a top-of-file import', () => {
        expect(Source.importSites(
            "import { AiProvider } from '@myorg/company-core';\nexport class Settings { activeAiProvider?: AiProvider; }\n",
        )).toEqual([]);
    });
});

describe('one-enum-spelling-in-api-lib — the scanner', () => {
    it('ALLOWS the one spelling: a string enum, one member of it, and a union of its members', () => {
        expect(Source.enumSites([
            "export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }",
            "export enum VoiceMode { RANDOM = 'random', FIXED = 'fixed', CHIRP = 'chirp' }",
            'export interface RandomVoice { mode: VoiceMode.RANDOM; }',
            'export interface OtherVoice { mode: VoiceMode.FIXED | VoiceMode.CHIRP; name: string; }',
            'export type Voice = RandomVoice | OtherVoice;',
            'export class Speaker { gender!: SpeakerGender; voice?: Voice; label: string | null = null; }',
        ].join('\n'))).toEqual([]);
    });

    it('refuses a literal-union TYPE ALIAS, printing the enum of the same name', () => {
        const sites = Source.enumSites("export type LessonType = 'story' | 'lesson';");

        expect(sites).toHaveLength(1);
        expect(sites[0]!.cure).toContain("export enum LessonType { STORY = 'story', LESSON = 'lesson' }");
    });

    it('refuses a literal union on a FIELD and on a PARAMETER, naming the enum for its owner', () => {
        const field = Source.enumSites("export class Clip { kind?: 'audio' | 'slot'; }");
        const param = Source.enumSites("export abstract class Api { find(kind: 'a' | 'b'): void {} }");

        expect(field[0]!.cure).toContain("export enum ClipKind { AUDIO = 'audio', SLOT = 'slot' }");
        expect(param[0]!.cure).toContain("export enum FindKind { A = 'a', B = 'b' }");
    });

    it('refuses `(typeof X)[number]`, printing the enum with the list\'s REAL values', () => {
        const sites = Source.enumSites([
            "export const SPEAKER_GENDERS = ['female', 'male'] as const;",
            'export class Speaker { gender!: (typeof SPEAKER_GENDERS)[number]; }',
        ].join('\n'));

        expect(sites).toHaveLength(1);
        expect(sites[0]!.what).toContain('(typeof SPEAKER_GENDERS)[number]');
        expect(sites[0]!.cure).toContain("export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }");
        expect(sites[0]!.cure).toContain('Object.values(SpeakerGender)');
    });

    it('refuses `keyof typeof X`', () => {
        const sites = Source.enumSites([
            "export const LABELS = { en: 'English', fr: 'French' } as const;",
            'export class Pick { locale!: keyof typeof LABELS; }',
        ].join('\n'));

        expect(sites).toHaveLength(1);
        expect(sites[0]!.cure).toContain("export enum LabelsKey { EN = 'en', FR = 'fr' }");
    });

    it('refuses a single-literal DISCRIMINATOR and a literal-union branch, printing one enum of every branch value', () => {
        const sites = Source.enumSites([
            "export interface RandomStoryVoice { mode: 'random'; }",
            "export interface ChirpRandomVoice { mode: 'randomWithChirp' | 'randomChirpMale'; }",
            "export interface FixedStoryVoice { mode: 'fixed'; name: string; }",
            'export type StoryVoiceChoice = RandomStoryVoice | ChirpRandomVoice | FixedStoryVoice;',
        ].join('\n'));
        const declaration =
            "export enum StoryVoiceChoiceMode { RANDOM = 'random', RANDOM_WITH_CHIRP = 'randomWithChirp', " +
            "RANDOM_CHIRP_MALE = 'randomChirpMale', FIXED = 'fixed' }";

        expect(sites).toHaveLength(3);
        for (const site of sites) expect(site.cure).toContain(declaration);
        expect(sites[0]!.cure).toContain('write `mode: StoryVoiceChoiceMode.RANDOM` here');
        expect(sites[1]!.cure).toContain(
            'write `mode: StoryVoiceChoiceMode.RANDOM_WITH_CHIRP | StoryVoiceChoiceMode.RANDOM_CHIRP_MALE` here',
        );
    });

    it('does not refuse a single literal that discriminates nothing', () => {
        expect(Source.enumSites("export interface Doc { version: '1'; }")).toEqual([]);
    });

    it('refuses a numeric, a heterogeneous, an uninitialised and a const enum', () => {
        const numeric = Source.enumSites('export enum Level { LOW = 1, HIGH = 2 }');
        const mixed = Source.enumSites("export enum Mixed { A = 'a', B = 2 }");
        const bare = Source.enumSites('export enum Tone { WARM, COOL_BLUE }');
        const constant = Source.enumSites("export const enum Flag { ON = 'on' }");

        expect(numeric[0]!.what).toContain('NUMBERS on the wire');
        expect(mixed[0]!.what).toContain('member(s) B are not initialised with a string literal');
        expect(bare[0]!.cure).toContain("export enum Tone { WARM = 'warm', COOL_BLUE = 'coolBlue' }");
        expect(constant[0]!.what).toContain('`const enum`');
        expect(constant[0]!.cure).toContain("export enum Flag { ON = 'on' }");
    });
});

describe('EnumText', () => {
    it('names members from values, collision-free', () => {
        expect(EnumText.memberName('randomWithChirp')).toBe('RANDOM_WITH_CHIRP');
        expect(EnumText.memberName('en-US')).toBe('EN_US');
        expect(EnumText.memberName('1x')).toBe('V_1X');
        expect(EnumText.members(['a-b', 'a_b']).map((m: { name: string }) => m.name)).toEqual(['A_B', 'A_B_2']);
        expect(EnumText.singularPascal('DISPLAY_LOCALE_CODES')).toBe('DisplayLocaleCode');
    });
});

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null keeps machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

class Repo {
    readonly root = specTempDirs.makeReal('api-lib-spelling-');

    constructor() {
        git(this.root, 'init -q -b main');
        git(this.root, 'config user.email test@test.com');
        git(this.root, 'config user.name test');
        this.write('placeholder.txt', 'x\n');
        this.project('libs/apis', 'api-lib');
        this.project('libs/util', 'lib');
        this.write('libs/apis/src/Old.ts', "export type Old = 'a' | 'b';\n");
        git(this.root, 'add -A');
        git(this.root, 'commit -q -m base');
        process.env['NX_BASE'] = git(this.root, 'rev-parse HEAD');
        delete process.env['NX_HEAD'];
    }

    project(dir: string, role: string): void {
        this.write(`${dir}/project.json`, JSON.stringify({ name: path.basename(dir), tags: [`role:${role}`] }));
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

function enumRule(mode: 'NEW_AND_MODIFIED_CODE' | 'NEW_AND_MODIFIED_FILES' | 'OFF'): OneEnumSpellingInApiLibValidator {
    const config = new OneEnumSpellingInApiLibConfig();
    config.mode = mode;
    return new OneEnumSpellingInApiLibValidator(config, new ProjectRoleResolver(), new DiffScope(), new GateScanScope());
}

function importRule(mode: 'NEW_AND_MODIFIED_CODE' | 'OFF'): NoInlineImportInApiLibValidator {
    const config = new NoInlineImportInApiLibConfig();
    config.mode = mode;
    return new NoInlineImportInApiLibValidator(config, new ProjectRoleResolver(), new DiffScope(), new GateScanScope());
}

describe('the two validators, end to end', () => {
    let repo: Repo;

    beforeEach(() => {
        repo = new Repo();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('THROWS a RuleFailError naming the file:line, with one Option per site', async () => {
        repo.write('libs/apis/src/Dtos.ts', "export class Clip {\n    kind?: 'audio' | 'slot';\n}\n");

        const failure = await failureOf(() => enumRule('NEW_AND_MODIFIED_CODE').run(repo.root));

        expect(failure?.ruleName).toBe('one-enum-spelling-in-api-lib');
        expect(failure?.humanMessage).toContain('libs/apis/src/Dtos.ts:2');
        expect(failure?.fixOptions.map((o: { text: string }) => o.text)).toEqual([
            expect.stringContaining("export enum ClipKind { AUDIO = 'audio', SLOT = 'slot' }"),
        ]);
    });

    it('judges ONLY role:api-lib projects', async () => {
        repo.write('libs/util/src/Dtos.ts', "export type Kind = 'a' | 'b';\n");

        expect(await failureOf(() => enumRule('NEW_AND_MODIFIED_FILES').run(repo.root))).toBeUndefined();
    });

    it('NEW_AND_MODIFIED_CODE grandfathers unchanged lines; NEW_AND_MODIFIED_FILES judges the whole changed file', async () => {
        repo.write('libs/apis/src/Old.ts', "export type Old = 'a' | 'b';\nexport const touched = 1;\n");

        expect(await failureOf(() => enumRule('NEW_AND_MODIFIED_CODE').run(repo.root))).toBeUndefined();
        expect((await failureOf(() => enumRule('NEW_AND_MODIFIED_FILES').run(repo.root)))?.humanMessage)
            .toContain('libs/apis/src/Old.ts:1');
    });

    it('honours a per-site disable and mode OFF', async () => {
        repo.write('libs/apis/src/Dtos.ts',
            "// webpieces-disable one-enum-spelling-in-api-lib -- a partner spec fixes these literals\nexport type K = 'a' | 'b';\n");

        expect(await failureOf(() => enumRule('NEW_AND_MODIFIED_CODE').run(repo.root))).toBeUndefined();
        repo.write('libs/apis/src/More.ts', "export type M = 'a' | 'b';\n");
        expect(await failureOf(() => enumRule('OFF').run(repo.root))).toBeUndefined();
    });

    it('finds a discriminator whose union lives in ANOTHER file of the api library', async () => {
        repo.write('libs/apis/src/Choice.ts', 'export type Choice = RandomVoice | FixedVoice;\n');
        repo.write('libs/apis/src/Voices.ts',
            "export interface RandomVoice { mode: 'random'; }\nexport interface FixedVoice { mode: 'fixed'; }\n");

        const failure = await failureOf(() => enumRule('NEW_AND_MODIFIED_CODE').run(repo.root));

        expect(failure?.fixOptions.map((o: { text: string }) => o.text)).toEqual([
            expect.stringContaining('write `mode: ChoiceMode.RANDOM` here'),
            expect.stringContaining('write `mode: ChoiceMode.FIXED` here'),
        ]);
    });

    it('no-inline-import-in-api-lib throws for an import() type in an api library', async () => {
        repo.write('libs/apis/src/Settings.ts',
            "export class Settings {\n    activeAiProvider?: import('@myorg/company-core').AiProvider;\n}\n");

        const failure = await failureOf(() => importRule('NEW_AND_MODIFIED_CODE').run(repo.root));

        expect(failure?.ruleName).toBe('no-inline-import-in-api-lib');
        expect(failure?.humanMessage).toContain('libs/apis/src/Settings.ts:2');
        expect(await failureOf(() => importRule('OFF').run(repo.root))).toBeUndefined();
    });
});
