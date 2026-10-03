import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ClientModuleResolution } from './client-module-resolution';
import { InformAiError } from '@webpieces/tooling-common';

class IsolatedClientFixture {
    readonly root = specTempDirs.make('wp-isolated-modules-');

    constructor() {
        this.write('package.json', { name: 'client', dependencies: { 'client-tooling': '1.0.0' } });
        this.write('node_modules/client-tooling/package.json', {
            name: 'client-tooling',
            version: '1.0.0',
            dependencies: { 'client-policy': '1.0.0' },
        });
        this.pack('node_modules/client-tooling/node_modules/client-policy');
    }

    pack(directory: string): void {
        this.write(`${directory}/package.json`, {
            name: 'client-policy',
            version: '1.0.0',
            exports: { './rule-pack': './manifest.cjs' },
        });
        fs.writeFileSync(
            path.join(this.root, directory, 'manifest.cjs'),
            'exports.rulePackManifest = {};\n',
        );
    }

    // webpieces-disable no-any-unknown -- fixture JSON writes package metadata, not production defaults.
    write(relative: string, value: unknown): void {
        const filename = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, JSON.stringify(value));
    }
}

describe('explicit module resolution through an isolated client bundle', () => {
    it('finds a selected public module through declared dependency roots without root hoisting', () => {
        const fixture = new IsolatedClientFixture();
        const resolved = new ClientModuleResolution(fixture.root).resolve(
            'client-policy/rule-pack',
        );
        expect(resolved).toBe(
            fs.realpathSync(
                path.join(
                    fixture.root,
                    'node_modules/client-tooling/node_modules/client-policy/manifest.cjs',
                ),
            ),
        );
    });

    it('does not scan an undeclared installed package for a selected module', () => {
        const fixture = new IsolatedClientFixture();
        fixture.write('package.json', { name: 'client', dependencies: {} });
        expect(() =>
            new ClientModuleResolution(fixture.root).resolve('client-policy/rule-pack'),
        ).toThrow('not installed through a declared client dependency');
    });

    it('rejects ambiguous nested installations instead of selecting a version by traversal order', () => {
        const fixture = new IsolatedClientFixture();
        fixture.write('package.json', {
            name: 'client',
            dependencies: { 'client-tooling': '1.0.0', 'other-tooling': '1.0.0' },
        });
        fixture.write('node_modules/other-tooling/package.json', {
            name: 'other-tooling',
            dependencies: { 'client-policy': '1.0.0' },
        });
        fixture.pack('node_modules/other-tooling/node_modules/client-policy');
        expect(() =>
            new ClientModuleResolution(fixture.root).resolve('client-policy/rule-pack'),
        ).toThrow('multiple installed versions');
        expect(() =>
            new ClientModuleResolution(fixture.root).resolve('client-policy/rule-pack'),
        ).toThrow(InformAiError);
    });
});
