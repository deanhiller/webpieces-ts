import { describe, it, expect, afterEach } from 'vitest';
import { API, CONTRACT_DIR, IpcWorkspace } from './__tests__/ipc-fixture';

/** `ipc-contract-shape` (#1389): the per-file contract checks of the replaced script's `metadata.mjs`. */
describe('ipc-contract-shape', () => {
    const workspaces: IpcWorkspace[] = [];

    afterEach(() => {
        for (const each of workspaces.splice(0)) each.dispose();
    });

    const refusalOf = (changes: Record<string, string>): Promise<string> => {
        const created = new IpcWorkspace(changes);
        workspaces.push(created);
        return created.shapeText();
    };

    const IMPORTS = "import {MaskLog,WpInternal,WpIpcEndpoint} from '@webpieces/core-util/ipc';";

    it('permits portable decorator metadata in shared contracts', async () => {
        expect(await refusalOf({})).toBe('');
    });

    it('rejects missing @WpInternal metadata', async () => {
        expect(await refusalOf({ [API]: 'export abstract class AudioToNativeApi { play():Promise<void>{throw new Error();} }' }))
            .toContain('IPC AudioToNativeApi needs @WpInternal');
    });

    it('rejects a method that is not one named required DTO returning Promise', async () => {
        const text = await refusalOf({
            [API]: `${IMPORTS} @WpInternal('audio') export abstract class AudioToNativeApi { @MaskLog({}) @WpIpcEndpoint('play') play():void{} }`,
        });
        expect(text).toContain('IPC AudioToNativeApi.play must take one named required DTO and return Promise.');
        expect(await refusalOf({
            [API]: `${IMPORTS} @WpInternal('audio') export abstract class AudioToNativeApi { @MaskLog({}) @WpIpcEndpoint('play') play(r?:{v:number}):Promise<void>{throw 1;} }`,
        })).toContain('must take one named required DTO');
    });

    it('rejects a missing endpoint or mask, duplicate ids, and a non-literal kind', async () => {
        const text = await refusalOf({
            [API]:
                `${IMPORTS} interface R {} @WpInternal('audio') export abstract class AudioToNativeApi { ` +
                "@WpIpcEndpoint('play') play(r:R):Promise<void>{throw 1;} " +
                "@MaskLog({}) @WpIpcEndpoint('play') again(r:R):Promise<void>{throw 1;} " +
                "@MaskLog({}) other(r:R):Promise<void>{throw 1;} " +
                "@MaskLog({}) @WpIpcEndpoint('x', { kind: someKind }) last(r:R):Promise<void>{throw 1;} }",
        });
        expect(text).toContain('IPC AudioToNativeApi.play needs explicit @MaskLog metadata.');
        expect(text).toContain('IPC AudioToNativeApi.again requires one uniquely identified @WpIpcEndpoint id.');
        expect(text).toContain('IPC AudioToNativeApi.other needs @WpIpcEndpoint');
        expect(text).toContain("IPC AudioToNativeApi.last @WpIpcEndpoint kind must be the literal 'request' or 'notification'.");
    });

    it('recognises decorators through an import rename', async () => {
        expect(await refusalOf({
            [API]:
                "import {MaskLog as M, WpInternal as I, WpIpcEndpoint as E} from '@webpieces/core-util/ipc'; interface R {} " +
                "@I('audio') export abstract class AudioToNativeApi { @M({}) @E('play') play(r:R):Promise<void>{throw 1;} }",
        })).toBe('');
    });

    it('rejects shared host imports and imports resolving into endpoint code', async () => {
        expect(await refusalOf({ [`${CONTRACT_DIR}/demo/bad.ts`]: "import { Component } from '@angular/core'; export const c = Component;" }))
            .toContain('never host or factory implementations');
        expect(await refusalOf({ [`${CONTRACT_DIR}/demo/bad.ts`]: "export { request } from '../../../../../services/angular/demo/shell-transport';" }))
            .toContain('cannot import endpoint/runtime implementations');
    });

    it('requires the configured classification tags on the contract project', async () => {
        expect(await refusalOf({ [`${CONTRACT_DIR}/project.json`]: JSON.stringify({ name: 'shell-api', tags: ['api:ipc-contract'] }) }))
            .toContain('must carry api:ipc-contract, framework:browser, framework:node (missing framework:browser, framework:node)');
    });
});
