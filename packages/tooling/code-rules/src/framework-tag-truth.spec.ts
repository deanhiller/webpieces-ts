/**
 * `framework-tsconfig` (D7) and `framework-packages` (D8) — the two PROJECT rules that make a
 * `framework:` tag true (#1064). Each has red and green cases; the "missing config entry fails the
 * load" half is in rules-config's tag-truth-configs.spec.ts, beside the schemas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FrameworkPackagesEntry, RuleFailError, renderRuleFailForHuman, specTempDirs } from '@webpieces/rules-config';
import { ScannedProject } from './project-scan-targets';
import { FrameworkTsconfigAudit, RuntimeCompilerOptions, frameworkTsconfigError } from './validate-framework-tsconfig';
import { FrameworkPackagesAudit, FrameworkPackageViolation, frameworkPackagesError } from './validate-framework-packages';

let root: string;

beforeEach(() => {
    root = specTempDirs.make('wp-framework-truth-');
    write('tsconfig.base.json', JSON.stringify({ compilerOptions: { target: 'es2022', strict: true } }));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

function libTsconfig(dir: string, compilerOptions: Record<string, string[]> | null): void {
    write(`${dir}/tsconfig.lib.json`, JSON.stringify({
        extends: '../../tsconfig.base.json',
        ...(compilerOptions === null ? {} : { compilerOptions }),
        include: ['src/**/*.ts'],
    }));
}

function project(name: string, frameworks: string[]): ScannedProject {
    return new ScannedProject(name, `libraries/${name}`, frameworks);
}

describe('framework-tsconfig (D7)', () => {
    it('picks the table row from the framework set', () => {
        expect(RuntimeCompilerOptions.forFrameworks(['react']).row).toBe('browser-only');
        expect(RuntimeCompilerOptions.forFrameworks(['browser', 'angular']).row).toBe('browser-only');
        expect(RuntimeCompilerOptions.forFrameworks(['express']).row).toBe('node-only');
        expect(RuntimeCompilerOptions.forFrameworks(['browser', 'node', 'react-native']).row).toBe('pure');
        expect(RuntimeCompilerOptions.forFrameworks(['browser', 'react-native']).row).toBe('pure');
        expect(RuntimeCompilerOptions.forFrameworks(['react-native']).row).toBe('pure');
    });

    it('GREEN: each runtime with the compiler options the table prescribes', () => {
        libTsconfig('libraries/web', { lib: ['es2022', 'dom'], types: [] });
        libTsconfig('libraries/srv', { lib: ['es2022'], types: ['node'] });
        libTsconfig('libraries/universal', { lib: ['es2022'], types: [] });
        const found = new FrameworkTsconfigAudit().audit(root, [
            project('web', ['browser']),
            project('srv', ['node']),
            project('universal', ['browser', 'node', 'react-native']),
        ]);
        expect(found).toEqual([]);
    });

    it('RED: a universal library with dom in lib and node in types', () => {
        libTsconfig('libraries/universal', { lib: ['es2022', 'dom'], types: ['node'] });
        const found = new FrameworkTsconfigAudit().audit(root, [project('universal', ['browser', 'node', 'react-native'])]);
        expect(found).toHaveLength(1);
        expect(found[0].problems).toEqual([
            '`lib` includes "dom", so `window`/`document`/`localStorage` compile where the runtime has none',
            '`types` includes "node", so `fs`/`process`/`__dirname`/`Buffer` compile where the runtime has none',
        ]);
        const text = renderRuleFailForHuman(frameworkTsconfigError(found));
        expect(text).toContain('libraries/universal/tsconfig.lib.json — universal [browser, node, react-native]');
        expect(text).toContain('set compilerOptions: { "lib": ["es2022"], "types": [] }');
    });

    it('RED: an UNSET lib and types count as dom + every @types — a browser+react-native library must state both', () => {
        libTsconfig('libraries/rnb', null);
        const found = new FrameworkTsconfigAudit().audit(root, [project('rnb', ['browser', 'react-native'])]);
        expect(found).toHaveLength(1);
        expect(found[0].problems[0]).toContain('`lib` is unset');
        expect(found[0].problems[1]).toContain('`types` is unset');
    });

    it('RED: a node library whose lib carries dom (inherited through extends) and whose types omit node', () => {
        write('tsconfig.base.json', JSON.stringify({ compilerOptions: { lib: ['es2022', 'dom'] } }));
        libTsconfig('libraries/srv', { types: [] });
        const found = new FrameworkTsconfigAudit().audit(root, [project('srv', ['express'])]);
        expect(found[0].problems).toEqual([
            '`lib` includes "dom", so `window`/`document`/`localStorage` compile where the runtime has none',
            '`types` does not include "node", so node\'s globals do not compile',
        ]);
    });

    it('RED: a browser library without dom', () => {
        libTsconfig('libraries/web', { lib: ['es2022'], types: [] });
        const found = new FrameworkTsconfigAudit().audit(root, [project('web', ['angular'])]);
        expect(found[0].problems).toEqual(['`lib` does not include "dom", so the browser globals its runtime has do not compile']);
    });

    it('skips a project with no tsconfig.lib.json (an app) and one with no framework tag', () => {
        write('libraries/app/tsconfig.app.json', '{}');
        libTsconfig('libraries/untagged', null);
        expect(new FrameworkTsconfigAudit().audit(root, [project('app', ['node']), project('untagged', [])])).toEqual([]);
    });
});

function entry(packages: string[], frameworks: string[]): FrameworkPackagesEntry {
    const e = new FrameworkPackagesEntry();
    e.packages = packages;
    e.frameworks = frameworks;
    return e;
}

const ENTRIES = [
    entry(['@angular/*'], ['angular']),
    entry(['react', 'react-native', 'expo*'], ['react', 'react-native']),
    entry(['express', 'firebase-admin', '@google-cloud/*'], ['node', 'express']),
    entry(['firebase'], ['browser', 'angular', 'react']),
];

describe('framework-packages (D8)', () => {
    it('GREEN: each framework package imported only where every runtime can run it; unlisted packages unjudged', () => {
        write('libraries/ng/src/a.ts', `import { Component } from '@angular/core';\nimport { map } from 'rxjs';`);
        write('libraries/srv/src/a.ts', `import express from 'express';\nimport { Storage } from '@google-cloud/storage';`);
        write('libraries/rn/src/a.ts', `import { View } from 'react-native';\nimport * as Camera from 'expo-camera';`);
        const found = new FrameworkPackagesAudit(ENTRIES).audit(root, [
            project('ng', ['angular']),
            project('srv', ['node']),
            project('rn', ['react-native']),
        ]);
        expect(found).toEqual([]);
    });

    it('RED: a browser+node library importing firebase-admin — its browser half cannot run it', () => {
        write('libraries/shared/src/db.ts', `import { x } from './x';\nimport * as admin from 'firebase-admin/app';`);
        const found = new FrameworkPackagesAudit(ENTRIES).audit(root, [project('shared', ['browser', 'node'])]);
        expect(found).toHaveLength(1);
        expect(found[0].packageName).toBe('firebase-admin');
        expect(found[0].at).toBe('libraries/shared/src/db.ts:2');
        const error = frameworkPackagesError(found);
        expect(error).toBeInstanceOf(RuleFailError);
        expect(renderRuleFailForHuman(error)).toContain(
            "libraries/shared/src/db.ts:2 — shared [browser, node] imports 'firebase-admin', which only [node, express] projects may import",
        );
    });

    it('RED: @angular/* in a react project, and react in a universal library', () => {
        write('libraries/web/src/a.tsx', `import { Injectable } from '@angular/core';`);
        write('libraries/universal/src/a.ts', `import { useState } from 'react';`);
        const found = new FrameworkPackagesAudit(ENTRIES).audit(root, [
            project('web', ['react']),
            project('universal', ['browser', 'node', 'react-native']),
        ]);
        expect(found.map((v: FrameworkPackageViolation) => `${v.project}:${v.packageName}`))
            .toEqual(['web:@angular/core', 'universal:react']);
    });

    it('reads production source only, and honours the per-site hatch', () => {
        write('libraries/shared/src/a.spec.ts', `import express from 'express';`);
        write('libraries/shared/src/__tests__/fake.ts', `import express from 'express';`);
        write('libraries/shared/src/b.ts', `// webpieces-disable framework-packages -- type-only, erased at compile time\nimport type { Request } from 'express';`);
        expect(new FrameworkPackagesAudit(ENTRIES).audit(root, [project('shared', ['browser', 'node'])])).toEqual([]);
    });

    it('does not read a nested project as part of its parent', () => {
        write('libraries/shared/nested/project.json', '{}');
        write('libraries/shared/nested/src/a.ts', `import express from 'express';`);
        expect(new FrameworkPackagesAudit(ENTRIES).audit(root, [project('shared', ['browser'])])).toEqual([]);
    });
});
