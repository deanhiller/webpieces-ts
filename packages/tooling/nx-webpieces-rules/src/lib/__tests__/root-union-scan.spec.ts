/**
 * `no-root-union-api-type` (#1009): a request or response type that IS a union must FAIL THE BUILD.
 *
 * The defect is not local. Both the OpenAI and the Anthropic function-calling APIs reject a
 * top-level `oneOf`/`anyOf`/`allOf`, and a server sends its WHOLE tool list on every request — so one
 * offending tool makes EVERY request 400 and the whole client session is unusable. A partner meets it
 * at runtime, in somebody else's client, where the symptom is that every OTHER tool broke.
 *
 * Two facts are asserted here that nothing else can assert:
 *
 *  - the rule fires on a contract that declares NO `@ApiType` (the reason it lives in the rules
 *    engine and not in the doc parser, which only ever visits contracts that HAVE one), and
 *  - a disable with NO reason is itself a violation.
 *
 * Builds a throwaway mini-workspace on disk, matching the sibling api-scanner specs, because the
 * scan walks real project roots.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    allRuleNames,
    sectionForRule,
    seedEntryForRule,
    CONFIG_FILENAME,
    specTempDirs,
} from '@webpieces/rules-config';
import { ProjectInfo } from '../project-info';
import { ApiUsageScanner, buildApiContracts } from '../api-usage/api-scanner';
import { RootUnionApiTypeError } from '../api-usage/api-contract-errors';
import {
    RootUnionApiType,
    RootUnionFindings,
    RootUnionRule,
    RootUnionScan,
} from '../api-usage/root-union-scan';

let root = '';

function write(relPath: string, contents: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

const DECORATORS = `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
export function ApiType(..._t: string[]): ClassDecorator { return (): void => undefined; }
export function Endpoint(_m: string, _p: string, _o: string, _k: string): MethodDecorator { return (): void => undefined; }
`;

function writeProject(name: string, body: string): void {
    write(`libraries/${name}/src/decorators.ts`, DECORATORS);
    write(`libraries/${name}/src/index.ts`, body);
    write(
        `libraries/${name}/tsconfig.json`,
        JSON.stringify({
            compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
            include: ['src/**/*.ts'],
        }),
    );
}

/** The union branches every fixture contract below shares. */
const WINDOWS = `export interface ScheduledWindow { kind: 'scheduled'; from: string; }
export interface AsapWindow { kind: 'asap'; estimateMinutes: number; }
`;

/**
 * A contract whose union is NESTED inside a property — the legal half, published as `oneOf` with its
 * derived discriminator. It also carries a string-literal union at the ROOT of a response, which is
 * NOT composition at all: it publishes as `enum`, a scalar, and must not be flagged.
 */
function writeNestedProject(): void {
    writeProject(
        'nested-api',
        `import { ApiPath, ApiType, Endpoint } from './decorators';

${WINDOWS}
export type DeliveryWindow = ScheduledWindow | AsapWindow;

export interface FetchRequest { window: DeliveryWindow; }
export interface FetchResponse { ok: boolean; }

@ApiType('mcp')
@ApiPath('/nested')
export abstract class NestedApi {
    @Endpoint(POST, '/fetch', READ, RPC)
    abstract fetch(request: FetchRequest): Promise<FetchResponse>;
}
`,
    );
}

/** A contract with NO `@ApiType`, whose REQUEST is the union. This is Part 3's proof. */
function writeNoApiTypeProject(): void {
    writeProject(
        'plain-api',
        `import { ApiPath, Endpoint } from './decorators';

${WINDOWS}
export type MoveWindowRequest = ScheduledWindow | AsapWindow;
export interface MoveWindowResponse { moved: boolean; }

@ApiPath('/plain')
export abstract class PlainApi {
    @Endpoint(POST, '/move', WRITE, RPC)
    abstract moveWindow(request: MoveWindowRequest): Promise<MoveWindowResponse>;
}
`,
    );
}

/** A contract whose RESPONSE is the union — the same defect on the other side of the call. */
function writeResponseProject(): void {
    writeProject(
        'response-api',
        `import { ApiPath, Endpoint } from './decorators';

${WINDOWS}
export type WindowResponse = ScheduledWindow | AsapWindow;
export interface LookRequest { id: string; }

@ApiPath('/response')
export abstract class ResponseApi {
    @Endpoint(POST, '/look', READ, RPC)
    abstract look(request: LookRequest): Promise<WindowResponse>;
}
`,
    );
}

/** Two disables: one that argues its case, and one that does not. */
function writeDisabledProject(): void {
    writeProject(
        'disabled-api',
        `import { ApiPath, Endpoint } from './decorators';

${WINDOWS}
export type ReasonedRequest = ScheduledWindow | AsapWindow;
export type ReasonlessRequest = ScheduledWindow | AsapWindow;
export interface Ack { ok: boolean; }

@ApiPath('/disabled')
export abstract class DisabledApi {
    // webpieces-disable no-root-union-api-type -- legacy partner body we cannot reshape until v2
    @Endpoint(POST, '/reasoned', WRITE, RPC)
    abstract reasoned(request: ReasonedRequest): Promise<Ack>;

    // webpieces-disable no-root-union-api-type
    @Endpoint(POST, '/reasonless', WRITE, RPC)
    abstract reasonless(request: ReasonlessRequest): Promise<Ack>;
}
`,
    );
}

function projects(...names: string[]): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    for (const name of names) {
        infos.set(name, new ProjectInfo(name, `libraries/${name}`, ['role:api-lib']));
    }
    return infos;
}

function scan(...names: string[]): RootUnionFindings {
    return new RootUnionScan(root, projects(...names)).run();
}

function names(found: readonly RootUnionApiType[]): string[] {
    return found.map((one: RootUnionApiType) => `${one.api}.${one.method}:${one.typeName}`);
}

/** A webpieces.config.json that VALIDATES, with this rule's entry replaced by `overrides`. */
// webpieces-disable no-any-unknown -- raw config JSON is an opaque option bag, as consumers write it
function writeConfig(overrides: Record<string, unknown>): string {
    const rules: Record<string, unknown> = {};
    const hookGuards: Record<string, unknown> = {};
    for (const name of allRuleNames()) {
        // webpieces-disable no-any-unknown -- one rule's opaque option bag
        const entry: Record<string, unknown> = {
            ...seedEntryForRule(name),
            mode: 'OFF',
            turnOffRuleUntilEpoch: 0,
            turnOffRuleWhileOnBranch: null,
        };
        const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
        target[name] = entry;
    }
    rules['no-root-union-api-type'] = {
        mode: 'RUN_EVERY_TIME',
        turnOffRuleUntilEpoch: 0,
        turnOffRuleWhileOnBranch: null,
        ...overrides,
    };
    const dir = specTempDirs.make('wp-root-union-config-');
    fs.writeFileSync(
        path.join(dir, CONFIG_FILENAME),
        JSON.stringify({
            rules,
            hookGuards,
            commands: {
                'pr-gate': {
                    mode: 'ON',
                    buildCommand: 'echo ci',
                    mergeMode: 'AUTO',
                    reviewerAgents: 1,
                    maxReviewerRounds: 2,
                },
            },
            excludePaths: [],
            'match-rules': [],
        }),
    );
    return dir;
}

beforeAll(() => {
    root = specTempDirs.makeReal('wp-root-union-');
    writeNestedProject();
    writeNoApiTypeProject();
    writeResponseProject();
    writeDisabledProject();
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('no-root-union-api-type', () => {
    it('ALLOWS a union nested inside a property, and a string-literal union anywhere', () => {
        expect(scan('nested-api').isEmpty()).toBe(true);
    });

    it('REFUSES a root-level union REQUEST on a contract that declares NO @ApiType', () => {
        const findings = scan('plain-api');

        expect(names(findings.violations)).toEqual(['PlainApi.moveWindow:MoveWindowRequest']);
        expect(findings.violations[0].side).toBe('request');
        expect(findings.violations[0].at).toContain('libraries/plain-api/src/index.ts:');
    });

    it('REFUSES a root-level union RESPONSE', () => {
        const findings = scan('response-api');

        expect(names(findings.violations)).toEqual(['ResponseApi.look:WindowResponse']);
        expect(findings.violations[0].side).toBe('response');
    });

    it('accepts a per-site disable WITH a reason, and rejects the same disable WITHOUT one', () => {
        const findings = scan('disabled-api');

        expect(names(findings.violations)).toEqual([]);
        expect(names(findings.reasonlessDisables)).toEqual([
            'DisabledApi.reasonless:ReasonlessRequest',
        ]);
    });

    it('FAILS THE BUILD through buildApiContracts, naming contract, method, type and cure', () => {
        const result = new ApiUsageScanner(root, projects('plain-api')).scan();

        expect(() => buildApiContracts(result)).toThrow(RootUnionApiTypeError);
        const message = messageOf(result);
        expect(message).toContain('PlainApi.moveWindow');
        expect(message).toContain("request type 'MoveWindowRequest'");
        expect(message).toContain('rejected by BOTH the OpenAI and');
        expect(message).toContain('ONE of these makes EVERY request 400');
        expect(message).toContain('Fix it by wrapping the union in a property of an object');
        expect(message).toContain('EVERY @ApiPath contract, with or without @ApiType');
        expect(message).toContain('// webpieces-disable no-root-union-api-type -- <reason>');
    });

    it('says the reason is MANDATORY when a disable gives none', () => {
        const result = new ApiUsageScanner(root, projects('disabled-api')).scan();
        const message = messageOf(result);

        expect(message).toContain('disable(s) of no-root-union-api-type give NO reason');
        expect(message).toContain('DisabledApi.reasonless');
        expect(message).toContain('The reason is MANDATORY');
    });

    it('is ARMED when the scanner is built with no configuration at all', () => {
        const rule = RootUnionRule.enabledEverywhere();

        expect(rule.enabled).toBe(true);
        expect(rule.allowedPaths).toEqual([]);
    });

    it('reads mode: OFF out of webpieces.config.json and finds nothing', () => {
        const configured = writeConfig({ mode: 'OFF' });

        expect(RootUnionRule.fromConfig(configured).enabled).toBe(false);
        expect(
            new ApiUsageScanner(
                root,
                projects('plain-api'),
                [],
                RootUnionRule.fromConfig(configured),
            )
                .scan()
                .rootUnions.isEmpty(),
        ).toBe(true);
    });

    it('reads allowedPaths out of webpieces.config.json and exempts that tree', () => {
        const configured = writeConfig({ allowedPaths: ['libraries/plain-api'] });
        const rule = RootUnionRule.fromConfig(configured);

        expect(rule.allowedPaths).toEqual(['libraries/plain-api']);
        expect(new RootUnionScan(root, projects('plain-api'), rule).run().isEmpty()).toBe(true);
    });
});

/** The rendered refusal for a scan that is known to have findings. */
// webpieces-disable no-function-outside-class -- spec helper, beside the tests that read it
function messageOf(result: ReturnType<ApiUsageScanner['scan']>): string {
    return new RootUnionApiTypeError(result.rootUnions).message;
}
