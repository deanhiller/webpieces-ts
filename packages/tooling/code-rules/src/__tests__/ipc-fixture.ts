import * as fs from 'fs';
import * as path from 'path';
import { DiffScope, RuleFailError } from '@webpieces/rules-config';
import { GitResultDto } from '@webpieces/tooling-common';
import { MockGitProcessApi, ProcessCallDto, specTempDirs } from '@webpieces/tooling-testkit';
import {
    IpcBoundaryConfig,
    IpcContractShapeConfig,
    IpcDirectionEntry,
    IpcPairingConfig,
    IpcProtocolFingerprintConfig,
} from '../configs/ipc-configs';
import { BaseRuleConfig } from '@webpieces/rules-sdk';
import { CodeValidator, ExecutorResult } from '../code-validator';
import { ProjectCatalog, ScanRestriction, ScanScope } from '../scan-scope';
import { IpcBoundaryValidator } from '../validate-ipc-boundary';
import { IpcContractShapeValidator } from '../validate-ipc-contract-shape';
import { IpcPairingValidator } from '../validate-ipc-pairing';
import { IpcProtocolFingerprintValidator } from '../validate-ipc-protocol-fingerprint';
import { IpcProtocolRecorder } from '../ipc/ipc-protocol-recorder';
import { IpcRuleSupport } from '../ipc/ipc-rule-support';

/**
 * The IPC rules' feature-test workspace (#1389) — the port of the replaced script's fixture: a website
 * composition + transport, a native receiver, one shared contract and its wire table, and a stub of the
 * two framework packages in node_modules. Files live in a temp dir; git is the scripted
 * {@link MockGitProcessApi} edge, answering from the files actually on disk, so no git process starts.
 */

export const CONTRACT_DIR = 'libraries/apis/internal/shell-api';
export const API = `${CONTRACT_DIR}/demo/Api.ts`;
export const WIRE = `${CONTRACT_DIR}/demo/wire-methods.ts`;
export const VERSION = `${CONTRACT_DIR}/demo/bridge-protocol.ts`;
export const MANIFEST = 'tools/ipc/protocol-manifest.json';
export const COMPOSITION = 'services/angular/demo/provide.ts';
export const TRANSPORT = 'services/angular/demo/shell-transport.ts';
export const ENDPOINT = 'mobile/demo/receiver.ts';
export const FEATURE = 'services/angular/demo/feature.ts';
export const BASE = 'base-sha';

const API_IMPORT = '../../../libraries/apis/internal/shell-api/demo/Api';

const BASELINE: Readonly<Record<string, string>> = {
    'tsconfig.base.json': '{}',
    'node_modules/@webpieces/core-util/package.json': JSON.stringify({
        name: '@webpieces/core-util',
        exports: { './ipc': './src/ipc/index.d.ts' },
    }),
    'node_modules/@webpieces/core-util/src/ipc/index.d.ts':
        'export type IpcApiType<T> = abstract new (...args: never[]) => T; export declare function WpInternal(id:string):ClassDecorator; ' +
        "export declare function WpIpcEndpoint(id:string,options?:{kind?:'request'|'notification'}):MethodDecorator; " +
        'export declare function MaskLog(mask:object):MethodDecorator; ' +
        'export declare class IpcConnection { request(value:unknown):Promise<unknown>; setHandler(handler:unknown):void; }',
    'node_modules/@webpieces/ipc-bridge/package.json': JSON.stringify({ name: '@webpieces/ipc-bridge', types: './index.d.ts' }),
    'node_modules/@webpieces/ipc-bridge/index.d.ts':
        "import { IpcApiType } from '@webpieces/core-util/ipc'; export declare class IpcClientFactory { createClient<T extends object>(api:IpcApiType<T>):T; } " +
        'export declare class IpcServerFactory { create<T extends object>(api:IpcApiType<T>,controller:T):void; ' +
        'createScoped<T extends object>(api:IpcApiType<T>,scope:{create(context:object):T}):void; }',
    [`${CONTRACT_DIR}/project.json`]: JSON.stringify({
        name: 'shell-api',
        tags: ['api:ipc-contract', 'framework:browser', 'framework:node'],
    }),
    [API]:
        "import { MaskLog, WpInternal, WpIpcEndpoint } from '@webpieces/core-util/ipc'; export interface PlayRequest { value:number; } " +
        "@WpInternal('audio') export abstract class AudioToNativeApi { @MaskLog({}) @WpIpcEndpoint('play') " +
        "play(_request:PlayRequest):Promise<void>{throw new Error('abstract');} }",
    [WIRE]:
        "export const WIRE_METHODS=[{api:'AudioToNativeApi',method:'play',wire:'audio.play',direction:'native',kind:'request',since:3}];",
    [VERSION]: 'export const MIN_BRIDGE_VERSION = 1;\nexport const BRIDGE_VERSION = 3;\n',
    'services/angular/demo/project.json': JSON.stringify({ name: 'website', tags: [] }),
    [COMPOSITION]:
        `import { IpcClientFactory as Factory } from '@webpieces/ipc-bridge'; import { AudioToNativeApi } from '${API_IMPORT}'; ` +
        'export const client=new Factory().createClient(AudioToNativeApi);',
    [TRANSPORT]: 'export async function request(value:unknown):Promise<unknown>{return value;}',
    'mobile/demo/project.json': JSON.stringify({ name: 'shell', tags: [] }),
    [ENDPOINT]:
        "import { IpcServerFactory } from '@webpieces/ipc-bridge'; import { AudioToNativeApi, PlayRequest } from " +
        "'../../libraries/apis/internal/shell-api/demo/Api'; class NativeAudio extends AudioToNativeApi { " +
        'async play(request:PlayRequest):Promise<void>{} } export function register(server:IpcServerFactory):void{' +
        'server.create(AudioToNativeApi,new NativeAudio());}',
    'unrelated/project.json': JSON.stringify({ name: 'unrelated', tags: [] }),
    'unrelated/src/thing.ts': 'export const thing = 1;',
};

/** A failure's text, or undefined when the run passed. The catch IS the assertion. */
export class IpcRun {
    // webpieces-disable no-any-unknown -- a rejected run is genuinely of unknown type; it is narrowed to RuleFailError below
    static async failureOf(run: () => Promise<unknown>): Promise<RuleFailError | undefined> {
        // webpieces-disable no-unmanaged-exceptions -- the throw IS what this helper returns
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await run();
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            if (err instanceof RuleFailError) return err;
            throw err;
        }
    }
}

export class IpcWorkspace {
    readonly root = specTempDirs.makeReal('ipc-rules-');
    readonly git = new MockGitProcessApi();
    /** Workspace files the scripted `git diff` reports as changed; undefined = every file. */
    changed: string[] | undefined;
    /** What `git show <base>:<manifest>` answers; undefined = the base has no manifest. */
    baseManifest: string | undefined;
    /** When false, no merge-base is found and NX_BASE is unset. */
    hasBase = true;

    constructor(changes: Readonly<Record<string, string>> = {}) {
        for (const [rel, content] of Object.entries({ ...BASELINE, ...changes })) this.write(rel, content);
        this.script();
    }

    write(rel: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, rel)), { recursive: true });
        fs.writeFileSync(path.join(this.root, rel), content);
    }

    remove(rel: string): void {
        fs.rmSync(path.join(this.root, rel), { force: true });
    }

    /** No merge-base anywhere: NX_BASE unset and `git merge-base` fails. */
    dropBase(): void {
        this.hasBase = false;
        delete process.env['NX_BASE'];
    }

    dispose(): void {
        delete process.env['NX_BASE'];
        fs.rmSync(this.root, { recursive: true, force: true });
    }

    boundaryConfig(): IpcBoundaryConfig {
        const config = new IpcBoundaryConfig();
        config.mode = 'NEW_AND_MODIFIED_FILES';
        config.tsconfigPath = 'tsconfig.base.json';
        config.transportFiles = [TRANSPORT];
        config.compositionFiles = [COMPOSITION, ENDPOINT];
        config.bootstrapFiles = [];
        config.testOnlyModuleSuffixes = ['.spec-support'];
        config.retiredModules = ['ipc-bus-promise'];
        config.retiredIdentifiers = ['requestShell', 'onShellPush'];
        config.forbiddenClassNamePatterns = ['To(Native|Website)Impl$'];
        config.legacyWireFile = null;
        config.bootstrapAllowedLegacyNames = [];
        config.legacyWireCommandPrefixes = ['audio.', 'media.'];
        return config;
    }

    shapeConfig(): IpcContractShapeConfig {
        const config = new IpcContractShapeConfig();
        config.mode = 'NEW_AND_MODIFIED_FILES';
        config.tsconfigPath = 'tsconfig.base.json';
        config.contractPaths = [`${CONTRACT_DIR}/**`];
        config.apiClassSuffixes = ['ToNativeApi', 'ToWebsiteApi'];
        config.requiredProjectTags = ['api:ipc-contract', 'framework:browser', 'framework:node'];
        config.forbiddenImportModules = ['@angular/*', 'react', 'react-native', 'expo*', '@webpieces/ipc-bridge'];
        config.forbiddenImportPaths = ['services/**', 'mobile/**'];
        return config;
    }

    pairingConfig(): IpcPairingConfig {
        const config = new IpcPairingConfig();
        config.mode = 'MODIFIED_PROJECTS';
        config.tsconfigPath = 'tsconfig.base.json';
        config.contractPaths = [`${CONTRACT_DIR}/**`];
        config.directions = [
            this.direction('ToNativeApi', 'native', ['services/angular/**'], [ENDPOINT]),
            this.direction('ToWebsiteApi', 'website', ['mobile/**'], ['services/angular/demo/website-endpoints.ts']),
        ];
        config.wireTableFile = WIRE;
        config.wireTableExport = 'WIRE_METHODS';
        config.forbiddenDispatchVariables = ['receivers'];
        return config;
    }

    fingerprintConfig(): IpcProtocolFingerprintConfig {
        const config = new IpcProtocolFingerprintConfig();
        config.mode = 'MODIFIED_PROJECTS';
        config.tsconfigPath = 'tsconfig.base.json';
        config.contractPaths = [`${CONTRACT_DIR}/**`];
        config.apiClassSuffixes = ['ToNativeApi', 'ToWebsiteApi'];
        config.wireTableFile = WIRE;
        config.wireTableExport = 'WIRE_METHODS';
        config.normalizedSourceFiles = [`${CONTRACT_DIR}/demo/*Api.ts`];
        config.manifestPath = MANIFEST;
        config.versionFile = VERSION;
        config.versionConstant = 'BRIDGE_VERSION';
        config.withoutBaseline = 'FAIL';
        return config;
    }

    boundary(config: IpcBoundaryConfig = this.boundaryConfig()): IpcBoundaryValidator {
        const diffScope = new DiffScope(this.git);
        const catalog = new ProjectCatalog(diffScope);
        return new IpcBoundaryValidator(config, diffScope, new ScanScope(diffScope, catalog, new ScanRestriction(undefined)), catalog);
    }

    shape(config: IpcContractShapeConfig = this.shapeConfig()): IpcContractShapeValidator {
        const diffScope = new DiffScope(this.git);
        const catalog = new ProjectCatalog(diffScope);
        return new IpcContractShapeValidator(config, diffScope, new ScanScope(diffScope, catalog, new ScanRestriction(undefined)), catalog);
    }

    pairing(config: IpcPairingConfig = this.pairingConfig()): IpcPairingValidator {
        const diffScope = new DiffScope(this.git);
        const catalog = new ProjectCatalog(diffScope);
        return new IpcPairingValidator(config, new ScanScope(diffScope, catalog, new ScanRestriction(undefined)), diffScope, catalog);
    }

    fingerprint(config: IpcProtocolFingerprintConfig = this.fingerprintConfig()): IpcProtocolFingerprintValidator {
        const diffScope = new DiffScope(this.git);
        return new IpcProtocolFingerprintValidator(config, diffScope, new ProjectCatalog(diffScope), this.git);
    }

    async boundaryText(config: IpcBoundaryConfig = this.boundaryConfig()): Promise<string> {
        return this.textOf(this.boundary(config));
    }

    async shapeText(config: IpcContractShapeConfig = this.shapeConfig()): Promise<string> {
        return this.textOf(this.shape(config));
    }

    async pairingText(config: IpcPairingConfig = this.pairingConfig()): Promise<string> {
        return this.textOf(this.pairing(config));
    }

    async fingerprintText(config: IpcProtocolFingerprintConfig = this.fingerprintConfig()): Promise<string> {
        return this.textOf(this.fingerprint(config));
    }

    /** Record the current snapshot as the committed manifest, returning its text. */
    async recordManifest(config: IpcProtocolFingerprintConfig = this.fingerprintConfig()): Promise<string> {
        const recorder = this.recorder();
        recorder.record(this.root, config, await recorder.current(this.root, config));
        return fs.readFileSync(path.join(this.root, config.manifestPath), 'utf8');
    }

    recorder(): IpcProtocolRecorder {
        const diffScope = new DiffScope(this.git);
        return new IpcProtocolRecorder(new IpcRuleSupport(diffScope, new ProjectCatalog(diffScope)));
    }

    /** The rule's refusal text, or '' when it passed. */
    private async textOf(validator: CodeValidator<BaseRuleConfig>): Promise<string> {
        const failure = await IpcRun.failureOf((): Promise<ExecutorResult> => validator.run(this.root));
        return failure?.humanMessage ?? '';
    }

    private direction(apiSuffix: string, wireDirection: string, senderFiles: string[], receiverFiles: string[]): IpcDirectionEntry {
        const entry = new IpcDirectionEntry();
        entry.apiSuffix = apiSuffix;
        entry.wireDirection = wireDirection;
        entry.senderFiles = senderFiles;
        entry.receiverFiles = receiverFiles;
        return entry;
    }

    /** Every git question the rules ask, answered from the files on disk at call time. */
    private script(): void {
        process.env['NX_BASE'] = BASE;
        delete process.env['NX_HEAD'];
        const tsGlob = ['--', '*.ts', '*.tsx'];
        const listed = (tsOnly: boolean): GitResultDto => this.git.ok(this.files(tsOnly).join('\n'));
        const changed = (tsOnly: boolean): GitResultDto =>
            this.git.ok((this.changed ?? this.files(false)).filter((rel: string) => !tsOnly || /\.tsx?$/.test(rel)).join('\n'));
        this.git.respond(['ls-files', '--cached', '--others', '--exclude-standard', ...tsGlob], () => listed(true));
        this.git.respond(['ls-files', '--cached', '--others', '--exclude-standard'], () => listed(false));
        this.git.respond(['ls-files', '--others', '--exclude-standard', ...tsGlob], this.git.ok(''));
        this.git.respond(['ls-files', '--others', '--exclude-standard'], this.git.ok(''));
        this.git.respond(['diff', '--name-only', '--diff-filter=d', BASE, ...tsGlob], () => changed(true));
        this.git.respond(['diff', '--name-only', '--diff-filter=d', BASE], () => changed(false));
        this.git.respondToPrefix(['merge-base'], () => (this.hasBase ? this.git.ok(BASE) : this.git.fail(1, 'no merge base')));
        this.git.respond(['ls-tree', '--name-only', BASE, '--', MANIFEST], () => this.git.ok(this.baseManifest === undefined ? '' : MANIFEST));
        this.git.respond(['show', `${BASE}:${MANIFEST}`], (call: ProcessCallDto) =>
            this.baseManifest === undefined ? this.git.fail(128, `fatal: no ${call.args[1]}`) : this.git.ok(this.baseManifest));
    }

    /** Every workspace file outside node_modules, workspace-relative and sorted — git's view. */
    private files(tsOnly: boolean): string[] {
        const out: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
                const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
                if (entry.name === 'node_modules') continue;
                if (entry.isDirectory()) walk(rel);
                else if (!tsOnly || /\.tsx?$/.test(rel)) out.push(rel);
            }
        };
        walk('');
        return out.sort();
    }
}
