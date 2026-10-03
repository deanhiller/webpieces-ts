import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { RepositoryPath } from './repository-path';
import { PackPolicyFiles } from './pack-policy-files';

describe('repository-owned policy paths', () => {
    it('canonicalizes roots and future paths without writing directories', () => {
        const root = specTempDirs.make('wp-rooted-policy-');
        expect(new RepositoryPath(root).resolve('.webpieces/rules/code.json')).toBe(
            path.join(fs.realpathSync(root), '.webpieces/rules/code.json'),
        );
        expect(fs.readdirSync(root)).toEqual([]);
    });

    it('rejects escaping symlinks, including dangling links', () => {
        const root = specTempDirs.make('wp-rooted-policy-'),
            outside = specTempDirs.make('wp-outside-policy-');
        fs.symlinkSync(outside, path.join(root, 'external'));
        expect(() => new RepositoryPath(root).resolve('external/config.json')).toThrow(
            'resolves outside',
        );
        fs.symlinkSync(path.join(outside, 'not-created'), path.join(root, 'dangling'));
        expect(() => new RepositoryPath(root).resolve('dangling/config.json')).toThrow();
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('rejects alias declarations for one file and aliases of reserved artifacts', () => {
        const root = specTempDirs.make('wp-rooted-policy-');
        fs.writeFileSync(path.join(root, 'owner.json'), '{}');
        fs.symlinkSync('owner.json', path.join(root, 'alias.json'));
        expect(() =>
            new PackPolicyFiles().declarations(
                [
                    { package: '@client/a', config: 'owner.json' },
                    { package: '@client/b', config: 'alias.json' },
                ],
                root,
            ),
        ).toThrow('Duplicate rule-pack declaration or config path');
        fs.writeFileSync(path.join(root, 'webpieces.config.json'), '{}');
        fs.symlinkSync('webpieces.config.json', path.join(root, 'reserved.json'));
        expect(() => new PackPolicyFiles().configPath(root, 'reserved.json')).toThrow(
            'Invalid pack config path',
        );
    });
});
