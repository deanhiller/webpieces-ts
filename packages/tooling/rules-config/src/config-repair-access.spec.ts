import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigFile } from './config-file';
import { PackPolicyFiles } from './pack-policy-files';
import { ConfigRepairAccess } from './config-repair-access';

describe('exact config repair targets before validation', () => {
    it('permits declared missing files and artifacts, while denying undeclared and outside files', () => {
        const root = specTempDirs.make('wp-config-repair-'),
            access = new ConfigRepairAccess();
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: '.webpieces/rules/client.json' }],
            }),
        );
        for (const filename of [
            'webpieces.config.json',
            '.webpieces/rules/client.json',
            '.webpieces/rules.lock.json',
            '.webpieces/instruct-ai/rules-catalog.md',
        ]) {
            expect(access.isRepairFile(root, path.join(root, filename)), filename).toBe(true);
        }
        for (const filename of [
            'src/client.json',
            '.webpieces/rules/other.json',
            'nested/webpieces.config.json',
            '../outside.json',
        ]) {
            expect(access.isRepairFile(root, path.join(root, filename)), filename).toBe(false);
        }
    });

    it('permits only root repair when declarations cannot be parsed or trusted', () => {
        const root = specTempDirs.make('wp-invalid-repair-'),
            access = new ConfigRepairAccess();
        for (const document of [
            '{',
            JSON.stringify({ rulePacks: [{ package: '@client/pack', config: '../escape.json' }] }),
        ]) {
            fs.writeFileSync(path.join(root, 'webpieces.config.json'), document);
            expect(access.isRepairFile(root, 'webpieces.config.json')).toBe(true);
            expect(access.isRepairFile(root, '.webpieces/rules/client.json')).toBe(false);
            expect(access.isRepairFile(root, '.webpieces/rules.lock.json')).toBe(false);
        }
    });

    it('rejects a declared path that escapes through a symlink', () => {
        const root = specTempDirs.make('wp-linked-repair-'),
            outside = specTempDirs.make('wp-repair-outside-');
        fs.symlinkSync(outside, path.join(root, 'linked'));
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: 'linked/config.json' }],
            }),
        );
        expect(new ConfigRepairAccess().isRepairFile(root, 'linked/config.json')).toBe(false);
    });
});
