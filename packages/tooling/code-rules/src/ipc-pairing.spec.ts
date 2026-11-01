import * as path from 'path';
import * as ts from 'typescript';
import { describe, it, expect, afterEach } from 'vitest';
import { API, COMPOSITION, CONTRACT_DIR, ENDPOINT, IpcWorkspace, WIRE } from './__tests__/ipc-fixture';
import { IpcContractInventoryReader, IpcWireTableRef } from './ipc/ipc-contract-inventory';
import { IpcCompilerOptionsReader } from './ipc/ipc-source';

/** `ipc-pairing` (#1389): the replaced script's `registrations.mjs` and the cross-file half of `metadata.mjs`. */
describe('ipc-pairing', () => {
    const workspaces: IpcWorkspace[] = [];

    afterEach(() => {
        for (const each of workspaces.splice(0)) each.dispose();
    });

    const workspace = (changes: Record<string, string>): IpcWorkspace => {
        const created = new IpcWorkspace(changes);
        workspaces.push(created);
        return created;
    };

    const refusalOf = (changes: Record<string, string>): Promise<string> => workspace(changes).pairingText();

    const RECEIVER_HEAD =
        "import {IpcServerFactory} from '@webpieces/ipc-bridge'; import {AudioToNativeApi,PlayRequest} from " +
        "'../../libraries/apis/internal/shell-api/demo/Api'; ";

    it('accepts resolved generated factory clients and shared receiver registration', async () => {
        expect(await refusalOf({})).toBe('');
    });

    it('rejects missing and duplicate actual receiver registrations', async () => {
        expect(await refusalOf({ [ENDPOINT]: '' })).toContain('requires exactly one framework receiver registration (found 0)');
        const duplicate =
            RECEIVER_HEAD +
            'class NativeAudio extends AudioToNativeApi {async play(request:PlayRequest):Promise<void>{}} ' +
            'const server=new IpcServerFactory(); server.create(AudioToNativeApi,new NativeAudio()); server.create(AudioToNativeApi,new NativeAudio());';
        expect(await refusalOf({ [ENDPOINT]: duplicate })).toContain('(found 2)');
    });

    it('rejects a shape-only receiver without the shared abstract base', async () => {
        const code = `${RECEIVER_HEAD}const server=new IpcServerFactory(); server.create(AudioToNativeApi,{async play(){}});`;
        expect(await refusalOf({ [ENDPOINT]: code })).toContain('registration must receive a concrete subclass of the same shared API');
    });

    it('accepts scoped registration of the actual shared subclass, a const controller, and an imported controller chain', async () => {
        const scoped =
            RECEIVER_HEAD +
            'class NativeAudio extends AudioToNativeApi {async play(request:PlayRequest):Promise<void>{}} ' +
            'const server=new IpcServerFactory(); server.createScoped(AudioToNativeApi,{create:()=>new NativeAudio()});';
        expect(await refusalOf({ [ENDPOINT]: scoped })).toBe('');
        const imported = {
            'mobile/demo/base.ts': "import {AudioToNativeApi as Shared} from '../../libraries/apis/internal/shell-api/demo/Api'; export abstract class Base extends Shared {}",
            'mobile/demo/audio.ts': "import {Base} from './base'; export class NativeAudio extends Base { async play():Promise<void>{} } export const audio = new NativeAudio();",
            [ENDPOINT]: `${RECEIVER_HEAD}import {audio} from './audio'; export function register(s:IpcServerFactory):void{ s.create(AudioToNativeApi, audio); }`,
        };
        expect(await refusalOf(imported)).toBe('');
    });

    it('rejects a receiver on the wrong endpoint and a missing client at the sender', async () => {
        const text = await refusalOf({
            [ENDPOINT]: '',
            'services/angular/demo/website-endpoints.ts': `${RECEIVER_HEAD.replace('../../', '../../../')}class A extends AudioToNativeApi {async play(r:PlayRequest):Promise<void>{}} export function r(s:IpcServerFactory):void{s.create(AudioToNativeApi,new A());}`,
            [COMPOSITION]: 'export const nothing = 1;',
        });
        expect(text).toContain('IPC AudioToNativeApi receiver is on the wrong endpoint.');
        expect(text).toContain('IPC AudioToNativeApi has no generated client at its sending endpoint.');
    });

    it('rejects a handwritten dispatch map and an unknown registered contract', async () => {
        const code =
            RECEIVER_HEAD +
            'class NativeAudio extends AudioToNativeApi {async play(request:PlayRequest):Promise<void>{}} ' +
            'const receivers = new Map(); export function r(s:IpcServerFactory):void{ s.create(AudioToNativeApi,new NativeAudio()); s.create(GhostToNativeApi, receivers); }';
        const text = await refusalOf({ [ENDPOINT]: code });
        expect(text).toContain('Remove the legacy receiver map');
        expect(text).toContain('IPC receiver registers unknown contract GhostToNativeApi.');
    });

    it('checks the wire table against the decorators', async () => {
        const text = await refusalOf({
            [WIRE]:
                "export const WIRE_METHODS=[{api:'AudioToNativeApi',method:'play',wire:'audio.play',direction:'website',kind:'event',since:-1}," +
                "{api:'AudioToNativeApi',method:'ghost',wire:'audio.play',direction:'native',kind:'request',since:1}];",
        });
        expect(text).toContain('IPC metadata AudioToNativeApi.ghost has no shared abstract API method.');
        expect(text).toContain('IPC wire registration is missing or duplicated: audio.play.');
        expect(text).toContain('IPC audio.play needs kind and since-protocol metadata.');
        expect(text).toContain('IPC audio.play direction does not match AudioToNativeApi.');
        expect(text).toContain('IPC AudioToNativeApi.play decorator kind must be notification.');
    });

    it('resolves wire rows written with imported constants and enum members', async () => {
        expect(await refusalOf({
            [`${CONTRACT_DIR}/demo/messages.ts`]: "export const AUDIO_PLAY = 'audio.play'; export enum Dir { NATIVE = 'native' }",
            [WIRE]: "import {AUDIO_PLAY, Dir} from './messages'; export const WIRE_METHODS=[{api:'AudioToNativeApi',method:'play',wire:AUDIO_PLAY,direction:Dir.NATIVE,kind:'request',since:3}];",
        })).toBe('');
    });

    it('runs under MODIFIED_PROJECTS only when an IPC project is touched', async () => {
        const ws = workspace({ [ENDPOINT]: '' });
        ws.changed = ['unrelated/src/thing.ts'];
        expect(await ws.pairingText()).toBe('');
        ws.changed = ['mobile/demo/project.json'];
        expect(await ws.pairingText()).toContain('requires exactly one framework receiver registration');
    });

    it('builds its type-checked program from the contract files alone', () => {
        const ws = workspace({});
        const options = new IpcCompilerOptionsReader().read(ws.root, 'tsconfig.base.json');
        const inventory = new IpcContractInventoryReader().read(
            ws.root,
            options,
            [API, WIRE],
            ['ToNativeApi'],
            new IpcWireTableRef(WIRE, 'WIRE_METHODS'),
        );
        const programFiles = inventory.program
            .getSourceFiles()
            .map((source: ts.SourceFile) => path.relative(ws.root, source.fileName))
            .filter((rel: string) => !rel.startsWith('..'));
        expect(programFiles.some((rel: string) => rel.startsWith('services/') || rel.startsWith('mobile/'))).toBe(false);
        expect(programFiles).toContain(API);
    });
});
