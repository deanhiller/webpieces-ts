import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExecutorContext, TargetConfiguration } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';
import { RuleFailError, specTempDirs } from '@webpieces/rules-config';
import runOpenApiGenerate, { OpenApiGenerate } from '../../executors/openapi-generate/executor';
import { DocsGenerate } from '../../executors/docs-generate/executor';

/**
 * A stand-in `wp-openapi`. It writes the three files a partner contract produces, plus YAML twins when
 * asked for `both`, so the executor can be driven end to end without the TypeScript compiler.
 */
const FAKE_OPENAPI = [
    "const fs = require('fs'); const path = require('path');",
    'const argv = process.argv.slice(2); const value = (flag) => argv[argv.indexOf(flag) + 1];',
    "const out = value('--out'); fs.mkdirSync(out, { recursive: true });",
    "if (!fs.existsSync(value('--manifest'))) { console.log('wp-openapi refused: no manifest'); process.exit(1); }",
    "for (const name of ['full-private-openapi', 'public-openapi']) {",
    "  fs.writeFileSync(path.join(out, name + '.json'), '{}');",
    "  if (value('--format') === 'both') fs.writeFileSync(path.join(out, name + '.yaml'), '{}');",
    '}',
    "fs.writeFileSync(path.join(out, 'mcp-PartnerOrdersApi-tools.json'), '[]');",
].join('\n');

/** A stand-in `wp-docs-site`: one home page and one operation page. */
const FAKE_DOCS_SITE = [
    "const fs = require('fs'); const path = require('path');",
    'const argv = process.argv.slice(2); const value = (flag) => argv[argv.indexOf(flag) + 1];',
    "const out = value('--out'); fs.readFileSync(value('--spec'));",
    "fs.mkdirSync(path.join(out, 'reference', 'fetch-orders'), { recursive: true });",
    "fs.writeFileSync(path.join(out, 'index.html'), 'home');",
    "fs.writeFileSync(path.join(out, 'reference', 'fetch-orders', 'index.html'), 'op');",
].join('\n');

/**
 * A consumer workspace: one api project in the #1023 shape — `build` (tsc, with the outputPath) and
 * `openapi-generate` dependsOn it — and (optionally) the generators.
 */
class Workspace {
    readonly root = fs.realpathSync(specTempDirs.make('wp-generated-docs-'));
    readonly targets: Record<string, TargetConfiguration> = {};

    constructor(readonly projectRoot: string, outputPath: string | undefined) {
        this.targets['build'] = { executor: '@nx/js:tsc', options: outputPath === undefined ? {} : { outputPath } };
        this.write(path.join(projectRoot, 'openapi.manifest.json'), '{}');
    }

    install(packageName: string, binName: string, version: string, script: string): void {
        const dir = path.join('node_modules', ...packageName.split('/'));
        this.write(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, version, bin: { [binName]: 'bin.js' } }));
        this.write(path.join(dir, 'bin.js'), script);
    }

    context(targetName: string): ExecutorContext {
        return {
            root: this.root,
            cwd: this.root,
            isVerbose: false,
            projectName: 'partner',
            targetName,
            projectsConfigurations: { version: 2, projects: { partner: { root: this.projectRoot, targets: this.targets } } },
            nxJsonConfiguration: {},
            projectGraph: { nodes: {}, dependencies: {} },
        };
    }

    write(relative: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relative), content);
    }

    exists(relative: string): boolean {
        return fs.existsSync(path.join(this.root, relative));
    }
}

const OPTIONS = { manifest: 'apps/partner/openapi.manifest.json', format: 'both' };

function rootDist(): Workspace {
    const ws = new Workspace('apps/partner', 'dist/apps/partner');
    ws.install('@webpieces/openapi-generator', 'wp-openapi', '0.4.812', FAKE_OPENAPI);
    ws.targets['openapi-generate'] = {
        executor: '@webpieces/nx-webpieces-rules:openapi-generate',
        dependsOn: ['build'],
        outputs: ['{workspaceRoot}/dist/apps/partner/*.json', '{workspaceRoot}/dist/apps/partner/*.yaml'],
        options: OPTIONS,
    };
    return ws;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('openapi-generate', () => {
    it('writes into a workspace-ROOT build outputPath (this repo’s layout)', () => {
        const ws = rootDist();

        new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate'));

        for (const file of ['public-openapi.json', 'public-openapi.yaml', 'full-private-openapi.json', 'mcp-PartnerOrdersApi-tools.json']) {
            expect(ws.exists(`dist/apps/partner/${file}`), file).toBe(true);
        }
        expect(ws.exists('apps/partner/generated')).toBe(false);
    });

    it('writes into a project-LOCAL build outputPath (monorepo-nx1’s layout) — the path is ASKED of nx', () => {
        const ws = new Workspace('libraries/apis/partner', 'libraries/apis/partner/dist');
        ws.install('@webpieces/openapi-generator', 'wp-openapi', '0.4.812', FAKE_OPENAPI);
        ws.write('apps/partner/openapi.manifest.json', '{}');
        ws.targets['openapi-generate'] = {
            dependsOn: ['build'], outputs: ['{projectRoot}/dist/*.json', '{projectRoot}/dist/*.yaml'], options: OPTIONS,
        };

        new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate'));

        expect(ws.exists('libraries/apis/partner/dist/public-openapi.json')).toBe(true);
        expect(ws.exists('dist')).toBe(false);
    });

    it('refuses a target with no dependsOn — it names the edit, since the clean would race the write', () => {
        const ws = rootDist();
        ws.targets['openapi-generate']!.dependsOn = [];

        expect(() => new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate'))).toThrow(RuleFailError);
        expect(() => new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate')))
            .toThrow(/must dependsOn exactly ONE target[\s\S]*names none/);
    });

    it('accepts nx’s object form of the same dependsOn', () => {
        const ws = rootDist();
        ws.targets['openapi-generate']!.dependsOn = [{ target: 'build' }];

        expect(new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate')).length).toBe(5);
    });

    it('writes into whichever target it dependsOn — the NAME is read, never hardcoded', () => {
        const ws = rootDist();
        ws.targets['tsc'] = { executor: '@nx/js:tsc', options: { outputPath: 'out/partner' } };
        ws.targets['openapi-generate']!.dependsOn = ['tsc', '^build'];
        ws.targets['openapi-generate']!.outputs = ['{workspaceRoot}/out/partner/*'];

        new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate'));

        expect(ws.exists('out/partner/mcp-PartnerOrdersApi-tools.json')).toBe(true);
    });

    it('refuses two sibling dependsOn — which outputPath is meant is ambiguous', () => {
        const ws = rootDist();
        ws.targets['openapi-generate']!.dependsOn = ['build', 'lint'];

        expect(() => new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate')))
            .toThrow(/names build, lint/);
    });

    it('refuses outputs that miss a written file — a cache hit would ship a package without it', () => {
        const ws = rootDist();
        ws.targets['openapi-generate']!.outputs = ['{workspaceRoot}/dist/apps/partner/*openapi.json', '{workspaceRoot}/dist/apps/partner/*.yaml'];

        expect(() => new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate')))
            .toThrow(/declared outputs do not cover[\s\S]*dist\/apps\/partner\/mcp-PartnerOrdersApi-tools\.json/);
    });

    it('refuses a build target that declares no outputPath, rather than assuming ./dist', () => {
        const ws = rootDist();
        ws.targets['build'] = { executor: '@nx/js:tsc', options: {} };

        expect(() => new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate')))
            .toThrow(/partner:build — the target openapi-generate dependsOn — declares no options\.outputPath/);
    });

    it('names the option key when a required option is missing — there is no default', () => {
        const ws = rootDist();

        expect(() => new OpenApiGenerate().run({ manifest: OPTIONS.manifest }, ws.context('openapi-generate')))
            .toThrow(/has no options\.format\. It is required and has no default/);
    });

    it('refuses when the consumer has no generator installed — it never falls back to a bundled one', () => {
        const ws = rootDist();
        fs.rmSync(path.join(ws.root, 'node_modules'), { recursive: true });

        expect(() => new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate')))
            .toThrow(/@webpieces\/openapi-generator is not installed/);
    });

    it('prints the version-handshake cure through the executor, and fails the task', async () => {
        const ws = rootDist();
        ws.install('@webpieces/openapi-generator', 'wp-openapi', '0.4.811', FAKE_OPENAPI);
        const printed: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((line: string): void => {
            printed.push(line);
        });

        const result = await runOpenApiGenerate(OPTIONS, ws.context('openapi-generate'));

        expect(result.success).toBe(false);
        expect(printed.join('\n')).toContain('Fix Option 1: (preferred) Bump the devDependency to @webpieces/openapi-generator >= 0.4.812');
        expect(ws.exists('dist/apps/partner/public-openapi.json')).toBe(false);
    });

    it('surfaces the generator’s own refusal and writes nothing', () => {
        const ws = rootDist();
        const options = { manifest: 'apps/partner/missing.json', format: 'json' };

        expect(() => new OpenApiGenerate().run(options, ws.context('openapi-generate')))
            .toThrow(/refused apps\/partner\/missing\.json:[\s\S]*wp-openapi refused: no manifest/);
        expect(ws.exists('dist/apps/partner')).toBe(false);
    });
});

describe('docs-generate', () => {
    const DOCS = { document: 'public-openapi.json', siteDir: 'generated-docs' };

    function withSite(): Workspace {
        const ws = rootDist();
        ws.install('@webpieces/docs-site', 'wp-docs-site', '0.4.810', FAKE_DOCS_SITE);
        ws.targets['docs-generate'] = {
            dependsOn: ['openapi-generate'],
            outputs: ['{projectRoot}/{options.siteDir}'],
            options: DOCS,
        };
        new OpenApiGenerate().run(OPTIONS, ws.context('openapi-generate'));
        return ws;
    }

    it('renders the site from the GENERATED document into <projectRoot>/<siteDir>, replacing stale pages', () => {
        const ws = withSite();
        ws.write('apps/partner/generated-docs/reference/deleted-op/index.html', 'stale');

        new DocsGenerate().run(DOCS, ws.context('docs-generate'));

        expect(ws.exists('apps/partner/generated-docs/index.html')).toBe(true);
        expect(ws.exists('apps/partner/generated-docs/reference/fetch-orders/index.html')).toBe(true);
        expect(ws.exists('apps/partner/generated-docs/reference/deleted-op/index.html')).toBe(false);
        // For hosting, not for the npm package: nothing of the site lands in the build output.
        expect(ws.exists('dist/apps/partner/generated-docs')).toBe(false);
    });

    it('refuses without dependsOn openapi-generate', () => {
        const ws = withSite();
        ws.targets['docs-generate']!.dependsOn = ['build'];

        expect(() => new DocsGenerate().run(DOCS, ws.context('docs-generate')))
            .toThrow(/does not declare dependsOn "openapi-generate"/);
    });

    it('refuses a document openapi-generate did not write', () => {
        const ws = withSite();

        expect(() => new DocsGenerate().run({ document: 'mcp-openapi.json', siteDir: 'generated-docs' }, ws.context('docs-generate')))
            .toThrow(/mcp-openapi\.json does not exist/);
    });

    it('refuses a siteDir outside the project — it is emptied on every run', () => {
        const ws = withSite();

        for (const siteDir of ['..', '.', '../../dist']) {
            expect(() => new DocsGenerate().run({ document: 'public-openapi.json', siteDir }, ws.context('docs-generate')), siteDir)
                .toThrow(/not a directory strictly inside apps\/partner/);
        }
    });

    it('names siteDir when it is missing — there is no default', () => {
        const ws = withSite();

        expect(() => new DocsGenerate().run({ document: 'public-openapi.json' }, ws.context('docs-generate')))
            .toThrow(/has no options\.siteDir/);
    });
});
