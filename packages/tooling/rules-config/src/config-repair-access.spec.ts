import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ConfigRepairAccess } from './config-repair-access';

describe('config repair targets are writable before validation (#1273)', () => {
    it('permits the root config, .gitignore, everything under .webpieces-config/ and declared owner files', () => {
        const root = specTempDirs.make('wp-config-repair-'),
            access = new ConfigRepairAccess();
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({
                rulePacks: [
                    { package: '@client/pack', config: '.webpieces-config/rules/client.json' },
                    { package: '@client/custom', config: 'policy/custom.json' },
                ],
            }),
        );
        for (const filename of [
            'webpieces.config.json',
            '.gitignore',
            '.webpieces-config/rules/client.json',
            '.webpieces-config/rules/undeclared-yet.json',
            '.webpieces-config/notes.md',
            'policy/custom.json',
        ]) {
            expect(access.isRepairFile(root, path.join(root, filename)), filename).toBe(true);
        }
        for (const filename of [
            'src/client.json',
            'policy/other.json',
            'nested/webpieces.config.json',
            '.webpieces-config',
            '../outside.json',
        ]) {
            expect(access.isRepairFile(root, path.join(root, filename)), filename).toBe(false);
        }
    });

    it('still permits the root config and .webpieces-config/ when the declarations cannot be parsed', () => {
        const root = specTempDirs.make('wp-invalid-repair-'),
            access = new ConfigRepairAccess();
        for (const document of [
            '{',
            '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> main\n',
            JSON.stringify({ rulePacks: [{ package: '@client/pack', config: '../escape.json' }] }),
        ]) {
            fs.writeFileSync(path.join(root, 'webpieces.config.json'), document);
            expect(access.isRepairFile(root, 'webpieces.config.json')).toBe(true);
            expect(access.isRepairFile(root, '.webpieces-config/rules/client.json')).toBe(true);
            expect(access.isRepairFile(root, 'src/client.json')).toBe(false);
        }
    });

    it('rejects a path that escapes the repository through a symlink, including a linked .webpieces-config', () => {
        const root = specTempDirs.make('wp-linked-repair-'),
            outside = specTempDirs.make('wp-repair-outside-');
        fs.symlinkSync(outside, path.join(root, 'linked'));
        fs.symlinkSync(outside, path.join(root, '.webpieces-config'));
        fs.writeFileSync(
            path.join(root, 'webpieces.config.json'),
            JSON.stringify({
                rulePacks: [{ package: '@client/pack', config: 'linked/config.json' }],
            }),
        );
        expect(new ConfigRepairAccess().isRepairFile(root, 'linked/config.json')).toBe(false);
        expect(new ConfigRepairAccess().isRepairFile(root, '.webpieces-config/rules/x.json')).toBe(false);
    });
});
