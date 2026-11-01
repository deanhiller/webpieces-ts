import * as fs from 'fs';
import { describe, it, expect, afterEach } from 'vitest';
import { API, BASE, IpcWorkspace, MANIFEST, VERSION } from './__tests__/ipc-fixture';

/**
 * `ipc-protocol-fingerprint` (#1389): the replaced script's `version.mjs` and `version.test.mjs`. The base
 * manifest is what scripted `git show <base>:<manifest>` answers; no git process starts.
 */
describe('ipc-protocol-fingerprint', () => {
    const workspaces: IpcWorkspace[] = [];

    afterEach(() => {
        for (const each of workspaces.splice(0)) each.dispose();
    });

    const workspace = (changes: Record<string, string> = {}): IpcWorkspace => {
        const created = new IpcWorkspace(changes);
        workspaces.push(created);
        return created;
    };

    const manifest = (protocol: number, fingerprint: string): string => `${JSON.stringify({ protocol, fingerprint }, null, 2)}\n`;

    const CHANGED_DTO = (text: string): string => text.replace('value:number;', 'value:number; extra?:string;');

    it('passes when the committed manifest matches the source and the base', async () => {
        const ws = workspace();
        const recorded = await ws.recordManifest();
        ws.baseManifest = recorded;
        expect(JSON.parse(recorded).protocol).toBe(3);
        expect(await ws.fingerprintText()).toBe('');
    });

    it('fails a stale manifest and names the record command', async () => {
        const ws = workspace();
        ws.write(MANIFEST, manifest(3, 'stale'));
        const text = await ws.fingerprintText();
        expect(text).toContain('IPC contract fingerprint changed');
        expect(text).toContain('increment BRIDGE_VERSION');
        expect(text).toContain('pnpm wp-ipc-record-protocol');
    });

    it('rejects a re-recorded wire change without a protocol increment relative to the branch base', async () => {
        const ws = workspace();
        ws.baseManifest = await ws.recordManifest();
        ws.write(API, CHANGED_DTO(fs.readFileSync(`${ws.root}/${API}`, 'utf8')));
        await ws.recordManifest();
        expect(await ws.fingerprintText()).toContain('IPC contract changed without a BRIDGE_VERSION increment relative to the branch base.');
        ws.write(VERSION, 'export const MIN_BRIDGE_VERSION = 1;\nexport const BRIDGE_VERSION = 4;\n');
        await ws.recordManifest();
        expect(await ws.fingerprintText()).toBe('');
    });

    it('refuses a protocol decrease, including on a revert', async () => {
        const ws = workspace();
        const recorded = await ws.recordManifest();
        ws.baseManifest = recorded.replace('"protocol": 3', '"protocol": 5');
        expect(await ws.fingerprintText()).toContain('BRIDGE_VERSION cannot decrease, including on a revert.');
    });

    it('a base without the manifest skips only the increment check', async () => {
        const ws = workspace();
        await ws.recordManifest();
        ws.baseManifest = undefined;
        expect(await ws.fingerprintText()).toBe('');
        expect(ws.git.commandLines()).toContain(`git ls-tree --name-only ${BASE} -- ${MANIFEST}`);
    });

    it('without a branch base: FAIL refuses, VERIFY_COMMITTED still verifies the committed manifest', async () => {
        const ws = workspace();
        await ws.recordManifest();
        ws.dropBase();
        const everyTime = ws.fingerprintConfig();
        everyTime.mode = 'RUN_EVERY_TIME';
        expect(await ws.fingerprintText(everyTime)).toContain('IPC protocol baseline lookup failed');
        everyTime.withoutBaseline = 'VERIFY_COMMITTED';
        expect(await ws.fingerprintText(everyTime)).toBe('');
        ws.write(MANIFEST, manifest(3, 'stale'));
        expect(await ws.fingerprintText(everyTime)).toContain('IPC contract fingerprint changed');
    });

    it('fingerprints API and method ids plus the resolved DTO shape, and never reads the floor as the protocol', async () => {
        const ws = workspace();
        const first = JSON.parse(await ws.recordManifest());
        ws.write(API, CHANGED_DTO(fs.readFileSync(`${ws.root}/${API}`, 'utf8')));
        const second = JSON.parse(await ws.recordManifest());
        expect(second.fingerprint).not.toBe(first.fingerprint);
        expect(second.protocol).toBe(3);
        ws.write(API, fs.readFileSync(`${ws.root}/${API}`, 'utf8').replace("@WpIpcEndpoint('play')", "@WpIpcEndpoint('play2')"));
        expect(JSON.parse(await ws.recordManifest()).fingerprint).not.toBe(second.fingerprint);
    });

    it('a comment or formatting change does not move the fingerprint', async () => {
        const ws = workspace();
        const first = JSON.parse(await ws.recordManifest());
        ws.write(API, `// a comment\n${fs.readFileSync(`${ws.root}/${API}`, 'utf8').replace(/; /g, ';\n    ')}`);
        expect(JSON.parse(await ws.recordManifest()).fingerprint).toBe(first.fingerprint);
    });

    it('a missing manifest names the record command', async () => {
        const ws = workspace();
        await expect(ws.fingerprint().run(ws.root)).rejects.toThrow(/does not exist\. Run pnpm wp-ipc-record-protocol/);
    });
});
