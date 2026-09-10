import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { ReactNativeCompatibility } from './react-native-compatibility';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(source: string): string {
    const root = mkdtempSync(join(tmpdir(), 'rn-compat-'));
    roots.push(root);
    writeFileSync(join(root, 'index.ts'), source);
    return root;
}
function inspect(root: string): string[] {
    return new ReactNativeCompatibility().inspect([join(root, 'index.ts')], {
        moduleResolution: ts.ModuleResolutionKind.Node10,
        allowJs: true,
    });
}
describe('React Native compatibility import closure', () => {
    it('accepts platform-neutral errors', () => {
        expect(inspect(fixture('export class UserError extends Error {}'))).toEqual([]);
    });
    it('rejects a Node built-in', () => {
        expect(
            inspect(fixture('import fs from "node:fs"; export const x = fs;')).join('\n'),
        ).toContain('Node module node:fs');
    });
    it('rejects DOM globals and globalThis bypasses', () => {
        expect(
            inspect(
                fixture('export const x = document.title; export const y = globalThis.window;'),
            ).join('\n'),
        ).toContain('global document');
        expect(inspect(fixture('export const x = globalThis.process;')).join('\n')).toContain(
            'global process',
        );
    });
    it('walks a transitive external dependency', () => {
        const root = fixture('export { x } from "dependency";');
        const dep = join(root, 'node_modules/dependency');
        mkdirSync(dep, { recursive: true });
        writeFileSync(
            join(dep, 'package.json'),
            JSON.stringify({ name: 'dependency', main: 'index.js' }),
        );
        writeFileSync(join(dep, 'index.js'), 'exports.x = require("fs");');
        expect(inspect(root).join('\n')).toContain('Node module fs');
    });
    it('does not let harmless declarations conceal a Node runtime', () => {
        const root = fixture('export { x } from "dependency";');
        const dep = join(root, 'node_modules/dependency');
        mkdirSync(dep, { recursive: true });
        writeFileSync(
            join(dep, 'package.json'),
            JSON.stringify({ name: 'dependency', main: 'index.js', types: 'index.d.ts' }),
        );
        writeFileSync(join(dep, 'index.d.ts'), 'export declare const x: string;');
        writeFileSync(join(dep, 'index.js'), 'exports.x = require("node:fs");');
        expect(inspect(root).join('\n')).toContain('Node module node:fs');
    });
    it('rejects dynamic loading', () => {
        expect(
            inspect(fixture('export const x = (name: string) => import(name);')).join('\n'),
        ).toContain('dynamic module loading');
    });
    it('rejects AbortSignal extensions missing from React Native without rejecting unrelated reasons', () => {
        const problems = inspect(
            fixture(
                'export function wait(cancellation: AbortSignal) { cancellation.throwIfAborted(); return cancellation.reason; }',
            ),
        ).join('\n');
        expect(problems).toContain('AbortSignal.throwIfAborted');
        expect(problems).toContain('AbortSignal.reason');
        expect(inspect(fixture('export const response = { status: { reason: "OK" } };'))).toEqual(
            [],
        );
    });
    it('rejects a tag with no required compatibility target', () => {
        const root = fixture('export {};');
        const file = join(root, 'project.json');
        writeFileSync(file, JSON.stringify({ tags: ['framework:react-native'] }));
        expect(new ReactNativeCompatibility().validateTarget(file).join('\n')).toContain(
            'requires a react-native-compat target',
        );
    });
    it('rejects a compatibility target that CI does not run', () => {
        const root = fixture('export {};');
        const file = join(root, 'project.json');
        writeFileSync(
            file,
            JSON.stringify({
                tags: ['framework:react-native'],
                targets: {
                    'react-native-compat': {
                        dependsOn: ['build'],
                        options: { command: 'check-rn' },
                    },
                },
            }),
        );
        expect(new ReactNativeCompatibility().validateTarget(file).join('\n')).toContain(
            'ci must depend on react-native-compat',
        );
    });
});
