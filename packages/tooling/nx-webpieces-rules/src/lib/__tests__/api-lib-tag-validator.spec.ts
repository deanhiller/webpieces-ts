import { specTempDirs } from '@webpieces/tooling-testkit';
/**
 * Tests the two-way role:api-lib / role:api-client tag ⇔ code validator (#1064, D3): synthetic scan
 * results for the @ApiPath half, real source in a temp workspace for the IPC / in-process / DTO-only
 * half.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { ProjectInfo } from '../project-info';
import type { ApiScanResult } from '../api-usage/api-scanner';
import {
    ApiLibTagViolation,
    describeApiLibTagViolation,
    findApiLibTagViolations,
} from '../api-usage/api-lib-tag-validator';

let root: string;

beforeEach(() => {
    root = specTempDirs.make('wp-api-lib-tag-');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function infos(entries: [string, string[]][]): Map<string, ProjectInfo> {
    const map = new Map<string, ProjectInfo>();
    for (const entry of entries) {
        map.set(entry[0], new ProjectInfo(entry[0], `apps/${entry[0]}`, entry[1]));
    }
    return map;
}

function source(project: string, file: string, text: string): void {
    const full = path.join(root, 'apps', project, 'src', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

function scan(apiLibs: string[], scanned: string[]): ApiScanResult {
    return {
        relationsByProject: new Map(),
        apiLibProjects: new Set(apiLibs),
        apiIndex: new Map(),
        scannedProjects: new Set(scanned),
        unresolvedApiCalls: [],
        nonLiteralDecoratorArgs: [],
    } as unknown as ApiScanResult;
}

describe('findApiLibTagViolations — the @ApiPath half', () => {
    it('flags a project that exports an API contract but carries neither api role', () => {
        const v = findApiLibTagViolations(
            infos([['some-api', ['role:lib']]]),
            scan(['some-api'], ['some-api']),
            root,
        );
        expect(v).toEqual([new ApiLibTagViolation('some-api', 'missing-tag', 'api-lib')]);
        expect(describeApiLibTagViolation(v[0])).toContain(
            "tagged neither 'role:api-lib' nor 'role:api-client'",
        );
    });

    it('accepts an @ApiPath contract on a role:api-client (a vendor contract plus its adapter)', () => {
        expect(
            findApiLibTagViolations(
                infos([['gmail', ['role:api-client']]]),
                scan(['gmail'], ['gmail']),
                root,
            ),
        ).toEqual([]);
    });

    it('passes when the tag matches the code both ways', () => {
        const v = findApiLibTagViolations(
            infos([
                ['some-api', ['role:api-lib']],
                ['a-server', ['role:server']],
            ]),
            scan(['some-api'], ['some-api', 'a-server']),
            root,
        );
        expect(v).toEqual([]);
    });

    it('does NOT judge a tag when the project was never scanned', () => {
        expect(
            findApiLibTagViolations(
                infos([['unscanned-api', ['role:api-lib']]]),
                scan([], []),
                root,
            ),
        ).toEqual([]);
    });
});

describe('findApiLibTagViolations — DTO-only, IPC and in-process api libraries (D3)', () => {
    it('accepts a DTO-only library: interfaces, aliases, enums and data classes', () => {
        source(
            'lang-dtos',
            'index.ts',
            `
            export interface PassageItemDto { id: string; }
            export type PassageIdDto = string;
            export enum AiProviderDto { CLAUDE = 'claude', CHATGPT = 'chatgpt' }
            export class LessonDto { title!: string; constructor(title: string) { this.title = title; } }
            export * from './more';
        `,
        );
        source('lang-dtos', 'more.ts', `export interface MoreDto { x: number; }`);
        expect(
            findApiLibTagViolations(
                infos([['lang-dtos', ['role:api-lib']]]),
                scan([], ['lang-dtos']),
                root,
            ),
        ).toEqual([]);
    });

    it('accepts an IPC contract library (@WpInternal / @WpIpcEndpoint)', () => {
        source(
            'shell-api',
            'ShellApi.ts',
            `
            import { WpInternal, WpIpcEndpoint } from '@webpieces/core-util';
            @WpInternal('shell')
            export abstract class ShellBridge {
                @WpIpcEndpoint('open') abstract open(req: OpenRequest): Promise<OpenResponse>;
            }
            export class OpenRequest { path!: string; }
            export class OpenResponse { ok!: boolean; }
            export const OPEN = 'open';
            export const PROTOCOL = { version: 1, methods: [OPEN] } as const;
        `,
        );
        expect(
            findApiLibTagViolations(
                infos([['shell-api', ['role:api-lib']]]),
                scan([], ['shell-api']),
                root,
            ),
        ).toEqual([]);
    });

    it('accepts an in-process contract: an abstract …Api behind a Symbol DI token', () => {
        source(
            'lesson-rules-api',
            'index.ts',
            `
            export const LESSON_TYPES = { LessonRuleLibApi: Symbol.for('LessonRuleLibApi') };
            export const VOCAB_TOKEN = Symbol('VocabularySourceApi');
            export abstract class LessonRuleLibApi { abstract check(req: CheckRequest): Promise<CheckResponse>; }
            export interface CheckRequest { text: string; }
            export interface CheckResponse { ok: boolean; }
        `,
        );
        expect(
            findApiLibTagViolations(
                infos([['lesson-rules-api', ['role:api-lib']]]),
                scan([], ['lesson-rules-api']),
                root,
            ),
        ).toEqual([]);
    });

    it('refuses a role:api-lib that holds an implementation, naming each offending export', () => {
        source(
            'company-core',
            'index.ts',
            `
            export interface TelemetryDto { at: number; }
            export class TelemetryUploader { upload(): void { /* talks to a server */ } }
            export function now(): number { return Date.now(); }
            export const DEFAULT_LIMIT = 10;
            export const upload = (): void => {};
        `,
        );
        const v = findApiLibTagViolations(
            infos([['company-core', ['role:api-lib']]]),
            scan([], ['company-core']),
            root,
        );
        expect(v).toHaveLength(1);
        expect(v[0].kind).toBe('unnecessary-tag');
        expect(v[0].offenders).toEqual([
            'class TelemetryUploader (src/index.ts) — it has methods, so it is an implementation',
            'const upload (src/index.ts)',
            'function now (src/index.ts)',
        ]);
        expect(describeApiLibTagViolation(v[0])).toContain('nor a DTO-only library');
    });

    it('refuses a role:api-lib that exports nothing at all', () => {
        source('empty', 'index.ts', `const hidden = 1; void hidden;`);
        expect(
            findApiLibTagViolations(
                infos([['empty', ['role:api-lib']]]),
                scan([], ['empty']),
                root,
            ),
        ).toHaveLength(1);
    });

    it('accepts a role:api-client exporting its abstract XxxApi beside the XxxClient', () => {
        source(
            'gcp-tts',
            'index.ts',
            `
            export abstract class TtsApi { abstract speak(req: SpeakRequest): Promise<SpeakResponse>; }
            export class TtsClient extends TtsApi { async speak(req: SpeakRequest): Promise<SpeakResponse> { return { audio: req.text }; } }
            export interface SpeakRequest { text: string; }
            export interface SpeakResponse { audio: string; }
        `,
        );
        expect(
            findApiLibTagViolations(
                infos([['gcp-tts', ['role:api-client']]]),
                scan([], ['gcp-tts']),
                root,
            ),
        ).toEqual([]);
    });

    it.each([
        ['apple-id', 'AppleIdKeysApi', 'AppleIdKeysClient'],
        ['firestore', 'FirestoreAdminApi', 'FirestoreAdminClient'],
        ['gcp-storage', 'StorageApi', 'GcpStorageClient'],
        ['gcp-tts', 'TextToSpeechApi', 'GcpTextToSpeechClient'],
        ['gmail', 'GmailApi', 'GmailClient'],
        ['image-fetch', 'ImageFetchApi', 'HttpImageFetchClient'],
    ])(
        'accepts reference api-client %s: an exported interface implemented by its registered default client',
        (project: string, api: string, client: string) => {
            source(project, 'api.ts', `export interface ${api} { call(): Promise<void>; }`);
            source(project, 'tokens.ts', `export const TYPES = { ${api}: Symbol.for('${api}') };`);
            source(
                project,
                'client.ts',
                `
                import { provideSingletonDefaultForApi } from '@webpieces/core-context';
                import { ${api} } from './api';
                import { TYPES } from './tokens';
                @provideSingletonDefaultForApi(TYPES.${api})
                export class ${client} implements ${api} { async call(): Promise<void> {} }
            `,
            );
            expect(
                findApiLibTagViolations(
                    infos([[project, ['role:api-client']]]),
                    scan([], [project]),
                    root,
                ),
            ).toEqual([]);
        },
    );

    it('does not accept an Api-named interface without a registered default implementation', () => {
        source(
            'unbound-client',
            'index.ts',
            `
            export interface VendorApi { call(): Promise<void>; }
            export class VendorClient implements VendorApi { async call(): Promise<void> {} }
        `,
        );
        expect(
            findApiLibTagViolations(
                infos([['unbound-client', ['role:api-client']]]),
                scan([], ['unbound-client']),
                root,
            ),
        ).toHaveLength(1);
    });

    it('refuses a role:api-client with no contract', () => {
        source('bare-client', 'index.ts', `export class GmailClient { send(): void {} }`);
        const v = findApiLibTagViolations(
            infos([['bare-client', ['role:api-client']]]),
            scan([], ['bare-client']),
            root,
        );
        expect(v).toHaveLength(1);
        expect(describeApiLibTagViolation(v[0])).toContain(
            "tagged 'role:api-client' but exports NO contract",
        );
    });
});
