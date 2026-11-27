import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DependencyPolicies, DependencyPolicyOptions } from '../dependency-policies';
import { ValidationTargets } from '../../validation-targets';

const directories: string[] = [];

class Fixture {
    readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-policy-'));

    constructor() {
        directories.push(this.root);
        this.json('package.json', {
            private: true,
            dependencies: { old: 'catalog:' },
            devDependencies: { vendor: 'catalog:' },
        });
        this.put(
            'pnpm-workspace.yaml',
            'packages:\n  - "packages/*"\ncatalog:\n  old: 1.0.0\n  vendor: 2.0.0\n  "@webpieces/core-util": 0.4.1010\n',
        );
        this.json('packages/app/package.json', {
            name: '@sample/app',
            dependencies: { vendor: 'catalog:' },
        });
        this.json('packages/app/project.json', { name: 'app' });
    }

    put(file: string, value: string): void {
        const target = path.join(this.root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, value);
    }

    json(file: string, value: unknown): void {
        this.put(file, JSON.stringify(value));
    }

    run(): string[] {
        return new DependencyPolicies().validate(
            this.root,
            new DependencyPolicyOptions(true, true, true, ['old'], ['tools/**'], [], [], []),
        );
    }
}

afterEach(() => {
    for (const directory of directories.splice(0))
        fs.rmSync(directory, { recursive: true, force: true });
});

describe('explicit workspace dependency policies', () => {
    it('accepts exact catalogue owners and ordinary transitive/peer package trees without flattening them', () => {
        const fixture = new Fixture();
        fixture.put(
            'packages/app/src/main.ts',
            'import { value } from "vendor/subpath"; console.log(value);',
        );
        fixture.json('node_modules/vendor/package.json', {
            name: 'vendor',
            version: '2.0.0',
            dependencies: { nested: '^3.0.0' },
        });
        fixture.json('node_modules/vendor/node_modules/nested/package.json', {
            name: 'nested',
            version: '3.1.0',
        });
        expect(fixture.run()).toEqual([]);
    });

    it('rejects new runtime, optional and peer root names while allowing catalogue root dev tools and removal', () => {
        for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            const fixture = new Fixture();
            fixture.json('package.json', { [section]: { vendor: 'catalog:' } });
            expect(fixture.run().join('\n')).toContain('new root runtime name');
        }
        const fixture = new Fixture();
        fixture.json('package.json', { devDependencies: { vendor: 'catalog:' } });
        expect(fixture.run()).toEqual([]);
        const options = new DependencyPolicyOptions(true, true, false, [], [], [], [], []);
        fixture.json('package.json', { dependencies: { old: 'catalog:' } });
        expect(new DependencyPolicies().validate(fixture.root, options).join('\n')).toContain(
            'new root runtime name',
        );
    });

    it('checks Webpieces and every direct declaration section, including missing and nonexact catalogue values', () => {
        for (const section of [
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
        ]) {
            const fixture = new Fixture();
            fixture.json('packages/app/package.json', {
                name: '@sample/app',
                [section]: { '@webpieces/core-util': '0.4.1010' },
            });
            expect(fixture.run().join('\n')).toContain('use catalog:');
        }
        for (const pin of ['^2.0.0', 'latest', '2', '02.0.0', '1.0.0-01']) {
            const fixture = new Fixture();
            fixture.put(
                'pnpm-workspace.yaml',
                `packages: ["packages/*"]\ncatalog: {old: 1.0.0, vendor: "${pin}"}\n`,
            );
            expect(fixture.run().join('\n')).toContain('must resolve to an exact version');
        }
        const fixture = new Fixture();
        fixture.json('packages/app/package.json', { dependencies: { absent: 'catalog:' } });
        expect(fixture.run().join('\n')).toContain('found undefined');
    });

    it('does not excuse missing owner declarations with root, a transitive dependency, or a dev declaration', () => {
        const fixture = new Fixture();
        fixture.put(
            'packages/app/src/main.ts',
            'import { value } from "vendor"; console.log(value);',
        );
        fixture.json('packages/app/package.json', {
            name: '@sample/app',
            devDependencies: { vendor: 'catalog:' },
        });
        expect(fixture.run().join('\n')).toContain('packages/app/package.json dependencies');
        fixture.json('packages/app/package.json', { name: '@sample/app' });
        expect(fixture.run().join('\n')).toContain('root/other-owner hoisting cannot satisfy');
    });

    it('keeps erased types and test imports in devDependencies, but sees reexports and aliased createRequire', () => {
        const fixture = new Fixture();
        fixture.json('packages/app/package.json', {
            name: '@sample/app',
            devDependencies: { vendor: 'catalog:' },
        });
        fixture.put(
            'packages/app/src/main.ts',
            'import type { Shape } from "vendor"; export type Result = Shape;',
        );
        fixture.put(
            'packages/app/src/main.spec-support.ts',
            'import { value } from "vendor"; console.log(value);',
        );
        expect(fixture.run()).toEqual([]);
        fixture.put('packages/app/src/main.ts', 'export { value } from "vendor";');
        expect(fixture.run().join('\n')).toContain('package.json dependencies');
        fixture.put(
            'packages/app/src/main.ts',
            'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("vendor/sub");',
        );
        expect(fixture.run().join('\n')).toContain('vendor must be declared');
    });

    it('requires explicit manifestless tool ownership and respects nested project/repository boundaries', () => {
        const fixture = new Fixture();
        fixture.json('tools/project.json', { name: 'tools' });
        fixture.put('tools/report.mjs', 'import vendor from "vendor"; console.log(vendor);');
        expect(fixture.run()).toEqual([]);
        fixture.json('packages/app/nested/project.json', { name: 'nested' });
        fixture.put(
            'packages/app/nested/main.ts',
            'import vendor from "vendor"; console.log(vendor);',
        );
        expect(fixture.run().join('\n')).toContain('no importing manifest');
        fixture.put('packages/app/nested/.git', 'gitdir: elsewhere');
        expect(fixture.run()).toEqual([]);
    });

    it('invalidates version and ownership gates on catalogue, policy, aliases and source changes', () => {
        const targets = new ValidationTargets();
        expect(JSON.stringify(targets.versionsLocked().inputs)).toContain('pnpm-workspace.yaml');
        expect(JSON.stringify(targets.versionsLocked().inputs)).toContain('.webpieces-config');
        expect(JSON.stringify(targets.packageJson().inputs)).toContain('tsconfig');
        expect(JSON.stringify(targets.packageJson().inputs)).toContain('tsx');
    });

    it('owns polyfills/styles and public declaration dependencies without promoting private erased types', () => {
        const fixture = new Fixture();
        fixture.json('packages/app/project.json', {
            name: 'app',
            targets: {
                build: {
                    options: { polyfills: ['vendor'], styles: ['node_modules/vendor/theme.css'] },
                },
            },
        });
        fixture.json('packages/app/package.json', {
            name: '@sample/app',
            devDependencies: { vendor: 'catalog:' },
        });
        expect(fixture.run().join('\n')).toContain('package.json dependencies');
        fixture.json('packages/app/project.json', { name: 'app' });
        fixture.json('packages/app/package.json', {
            name: '@sample/app',
            types: 'index.d.ts',
            devDependencies: { vendor: 'catalog:' },
        });
        fixture.put(
            'packages/app/src/main.ts',
            'import type { Shape } from "vendor"; export type Result = Shape;',
        );
        expect(fixture.run().join('\n')).toContain('package.json dependencies');
        fixture.json('packages/app/package.json', {
            name: '@sample/app',
            private: true,
            types: 'index.d.ts',
            devDependencies: { vendor: 'catalog:' },
        });
        expect(fixture.run()).toEqual([]);
    });

    it('does not mistake an artifact probe for a dependency of its test runner', () => {
        const fixture = new Fixture();
        fixture.put(
            'packages/app/src/probe.spec.ts',
            'import { createRequire } from "node:module"; const probe = createRequire("/tmp/image/owner.js"); probe("vendor");',
        );
        fixture.json('packages/app/package.json', { name: '@sample/app' });
        expect(fixture.run()).toEqual([]);
    });
});
