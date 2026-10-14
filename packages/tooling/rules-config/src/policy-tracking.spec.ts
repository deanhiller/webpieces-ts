import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RepositoryLayout } from '@webpieces/tooling-common';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { PolicyTracking } from './policy-tracking';
import { PackPolicyDeclaration } from './pack-policy-files';

class TrackingFixture {
    readonly root = specTempDirs.makeReal('wp-tracked-policy-');
    readonly tracking = new PolicyTracking();
    readonly declarations = [
        new PackPolicyDeclaration('@client/pack', '.webpieces-config/rules/client.json'),
    ];
    constructor() {
        execFileSync('git', ['init', '-q'], { cwd: this.root });
        fs.mkdirSync(path.join(this.root, '.webpieces-config/rules'), { recursive: true });
        for (const name of ['rules/client.json', 'rules.lock.json', 'rules-catalog.md'])
            fs.writeFileSync(path.join(this.root, '.webpieces-config', name), '{}');
        fs.writeFileSync(path.join(this.root, 'webpieces.config.json'), '{}');
        fs.writeFileSync(path.join(this.root, '.gitignore'), '.webpieces/\n');
    }
}

describe('policy must be committed inputs', () => {
    it('blocks untracked policy, and accepts it once explicitly staged', () => {
        const fixture = new TrackingFixture();
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).toThrow(
            'wp-migrate-dirs --stage',
        );
        fixture.tracking.stage(fixture.root, fixture.declarations);
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).not.toThrow();
        fs.mkdirSync(path.join(fixture.root, '.webpieces'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, '.webpieces/build.log'), 'runtime');
        expect(
            execFileSync('git', ['status', '--short', '--untracked-files=all'], {
                cwd: fixture.root,
                encoding: 'utf8',
            }),
        ).not.toContain('build.log');
    });
    it('stages the old tracked policy deletions so a clone cannot recreate the retired layout', () => {
        const fixture = new TrackingFixture();
        fs.mkdirSync(path.join(fixture.root, '.webpieces/rules'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, '.webpieces/rules/client.json'), '{}');
        execFileSync('git', ['add', '-f', '--', '.webpieces/rules/client.json'], { cwd: fixture.root });
        new RepositoryLayout().migrate(fixture.root);
        fixture.tracking.stage(fixture.root, fixture.declarations);
        expect(
            execFileSync('git', ['ls-files', '--', '.webpieces'], {
                cwd: fixture.root,
                encoding: 'utf8',
            }),
        ).toBe('');
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).not.toThrow();
    });
    it('blocks ignored policy even when it is already tracked', () => {
        const fixture = new TrackingFixture();
        fixture.tracking.stage(fixture.root, fixture.declarations);
        fs.appendFileSync(path.join(fixture.root, '.gitignore'), '.webpieces-config/\n');
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).toThrow(
            'policy is gitignored',
        );
    });
    it('requires a tracked symlink target as well as its declaration', () => {
        const fixture = new TrackingFixture();
        fixture.tracking.stage(fixture.root, fixture.declarations);
        const owner = path.join(fixture.root, fixture.declarations[0].config);
        fs.unlinkSync(owner);
        fs.writeFileSync(path.join(fixture.root, '.webpieces-config/rules/actual.json'), '{}');
        fs.symlinkSync('actual.json', owner);
        execFileSync('git', ['add', '--', fixture.declarations[0].config], { cwd: fixture.root });
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).toThrow(
            'actual.json',
        );
        fixture.tracking.stage(fixture.root, fixture.declarations);
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).not.toThrow();
    });
    it('requires the lock and catalog as well as every declared owner file', () => {
        const fixture = new TrackingFixture();
        execFileSync('git', ['add', '--', '.webpieces-config/rules/client.json'], {
            cwd: fixture.root,
        });
        expect(() => fixture.tracking.check(fixture.root, fixture.declarations)).toThrow(
            'rules.lock.json',
        );
    });
});
