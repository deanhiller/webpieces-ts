import { describe, it, expect, afterEach } from 'vitest';
import { COMPOSITION, FEATURE, IpcWorkspace, TRANSPORT } from './__tests__/ipc-fixture';

/**
 * `ipc-boundary` (#1389), driven the way the gate drives it: the validator over a workspace whose git is
 * scripted. The cases are the replaced script's `inspect.test.mjs` fixtures, plus the scope modes.
 */
describe('ipc-boundary', () => {
    const workspaces: IpcWorkspace[] = [];

    afterEach(() => {
        for (const each of workspaces.splice(0)) each.dispose();
    });

    const workspace = (changes: Record<string, string>): IpcWorkspace => {
        const created = new IpcWorkspace(changes);
        workspaces.push(created);
        return created;
    };

    const refusalOf = (changes: Record<string, string>): Promise<string> => workspace(changes).boundaryText();

    it('accepts resolved generated factory clients and shared receiver registration', async () => {
        expect(await refusalOf({})).toBe('');
    });

    it('rejects aliased factory construction and factory methods in feature code', async () => {
        const text = await refusalOf({
            [FEATURE]: "import { IpcClientFactory as F } from '@webpieces/ipc-bridge'; const f=new F(); const client=f.createClient({} as never);",
        });
        expect(text).toContain(`${FEATURE}:1 — Use an injected shared directional API`);
        expect(text).toContain('new F()');
        expect(text).toContain('f.createClient');
    });

    it('rejects raw transport extraction and WebView aliases', async () => {
        expect(await refusalOf({ [FEATURE]: "import {request as send} from './shell-transport'; const escaped=send; escaped({});" }))
            .toContain('request as send');
        expect(await refusalOf({ 'mobile/demo/feature.ts': "declare const webView:any; const alias=webView; alias.injectJavaScript('bad');" }))
            .toContain('alias.injectJavaScript');
        expect(await refusalOf({ 'mobile/demo/feature.ts': 'declare const ref:any; const { postMessage } = ref.webView; postMessage("x");' }))
            .toContain('postMessage');
    });

    it('rejects the retired vendor bus, retired helpers and handwritten directional clients', async () => {
        const text = await refusalOf({
            [FEATURE]: "import {IpcBus} from 'ipc-bus-promise'; class AudioToNativeImpl {} const x = requestShell; const y = require('ipc-bus-promise');",
        });
        expect(text).toContain('This module is retired');
        expect(text).toContain('Handwritten directional wire clients are retired');
        expect(text).toContain('This raw IPC helper is retired');
        expect(text).toContain("require('ipc-bus-promise')");
    });

    it('does not flag unrelated postMessage or ordinary business create methods', async () => {
        expect(await refusalOf({
            [FEATURE]: "const worker={postMessage(value:string){},create(){}}; worker.postMessage('x'); worker.create();",
        })).toBe('');
    });

    it('rejects raw IpcConnection imports, construction and calls outside the transport', async () => {
        const text = await refusalOf({
            [FEATURE]: "import {IpcConnection as C} from '@webpieces/core-util/ipc'; const connection=new C(); connection.request({});",
        });
        expect(text).toContain('IpcConnection as C');
        expect(text).toContain('new C()');
        expect(text).toContain('connection.request');
        expect(await refusalOf({
            [COMPOSITION]: "import {IpcConnection} from '@webpieces/core-util/ipc'; export function wire(c: IpcConnection): void { c.setHandler(() => 1); }",
        })).toContain('c.setHandler');
    });

    it('rejects production imports of test-only scaffolding, and legacy wire commands in the transport', async () => {
        expect(await refusalOf({ [FEATURE]: "import { fake } from './fixture.spec-support'; export const f = fake;" }))
            .toContain('Production code cannot import test-only IPC scaffolding.');
        expect(await refusalOf({ [TRANSPORT]: "export async function request(value:unknown):Promise<unknown>{return ['audio.play', value];}" }))
            .toContain('Do not author legacy feature wire commands');
    });

    it('refuses a transport importing a legacy wire constant, but lets bootstrap import the discovery message', async () => {
        const ws = workspace({
            'libraries/apis/internal/shell-api/demo/shell-messages.ts': "export const APPLICATION_READY = 'ready'; export const AUDIO_PLAY = 'audio.play';",
            [TRANSPORT]: "import { AUDIO_PLAY } from '../../../libraries/apis/internal/shell-api/demo/shell-messages'; export const x = AUDIO_PLAY;",
            'services/angular/demo/shell-bootstrap.ts':
                "import { APPLICATION_READY } from '../../../libraries/apis/internal/shell-api/demo/shell-messages'; export const r = APPLICATION_READY;",
        });
        const config = ws.boundaryConfig();
        config.legacyWireFile = 'libraries/apis/internal/shell-api/demo/shell-messages.ts';
        config.bootstrapFiles = ['services/angular/demo/shell-bootstrap.ts'];
        config.bootstrapAllowedLegacyNames = ['APPLICATION_READY'];
        const text = await ws.boundaryText(config);
        expect(text).toContain(`${TRANSPORT}:1 — Only protocol bootstrap may use the raw discovery operation`);
        expect(text).not.toContain('shell-bootstrap.ts');
    });

    it('NEW_AND_MODIFIED_FILES judges only changed files; RUN_EVERY_TIME judges them all; OFF judges none', async () => {
        const ws = workspace({ [FEATURE]: "import {IpcBus} from 'ipc-bus-promise';" });
        ws.changed = [COMPOSITION];
        expect(await ws.boundaryText()).toBe('');
        const everyTime = ws.boundaryConfig();
        everyTime.mode = 'RUN_EVERY_TIME';
        expect(await ws.boundaryText(everyTime)).toContain(FEATURE);
        const off = ws.boundaryConfig();
        off.mode = 'OFF';
        ws.changed = undefined;
        expect(await ws.boundaryText(off)).toBe('');
    });

    it('never judges spec files', async () => {
        expect(await refusalOf({ 'services/angular/demo/feature.spec.ts': "import {IpcBus} from 'ipc-bus-promise';" })).toBe('');
    });
});
