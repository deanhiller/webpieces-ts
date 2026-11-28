import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { McpToolCatalogFile } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';
import { OperationIds, OperationIdStyle } from '../model/OperationIds';

const ROOT = path.resolve(__dirname, '../../../../..');
const FIXTURE = path.join(ROOT, 'packages/http/mcp-server/src/__tests__/McpIdentityFixtures.ts');
const GOLDEN = path.join(__dirname, 'goldens/mcp-RenamedApi-tools.json');
const OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: ROOT,
    paths: { '@webpieces/core-util': ['packages/core/core-util/src/index.ts'] },
};

/** Override only source-file I/O; the extractor, compiler binding and renderer all run normally. */
class IdentitySource {
    static catalog(source = fs.readFileSync(FIXTURE, 'utf8')): McpToolCatalogFile {
        const host = ts.createCompilerHost(OPTIONS, true);
        const read = host.readFile.bind(host);
        host.readFile = (file: string): string | undefined =>
            file === FIXTURE ? source : read(file);
        const program = ts.createProgram([FIXTURE], OPTIONS, host);
        const model = new ApiDocExtractor()
            .extractAllFrom(program, program.getSourceFile(FIXTURE)!)
            .find((each) => each.contractName === 'RenamedApi')!;
        const rendered = McpSchemaRenderer.catalogOf(
            [model],
            new OperationIds(OperationIdStyle.CONTRACT_METHOD),
        );
        expect(rendered.skipped).toEqual([]);
        return rendered.catalogs[0];
    }
}

/** The generated file is ALSO loaded by the real HTTP/in-memory feature test. */
describe('multiple MCP identities from one endpoint source', () => {
    it('extracts all identities independent of decorator order and publishes their unchanged method schemas', () => {
        const catalog = IdentitySource.catalog();
        if (process.env['UPDATE_MCP_GOLDEN']) fs.writeFileSync(GOLDEN, catalog.toJsonText());
        expect(catalog.toJsonText()).toBe(fs.readFileSync(GOLDEN, 'utf8'));
        const loaded = McpToolCatalogFile.fromJsonText(catalog.fileName, catalog.toJsonText());
        expect(loaded.names()).toEqual([
            'aideveloper_inspect_issues',
            'aideveloper_list_issues',
            'bugfixer_inspect_issues',
            'bugfixer_list_issues',
        ]);
        for (const method of ['list', 'inspect']) {
            const legacy = loaded.find(`bugfixer_${method}_issues`)!;
            const renamed = loaded.find(`aideveloper_${method}_issues`)!;
            expect(legacy.methodName).toBe(method);
            expect(renamed).toEqual({ ...legacy, name: renamed.name, profiles: ['aideveloper'] });
            expect(legacy.profiles).toEqual(['default']);
        }
    });
    it('is independent of decorator order and resolves imported aliases and namespace imports', () => {
        const source = fs.readFileSync(FIXTURE, 'utf8');
        const reversed = source.replace(
            /(@WpMcpTool\('bugfixer_list_issues'[^\n]+)\n(\s*@WpMcpTool\('aideveloper_list_issues'[^\n]+)/,
            '$2\n    $1',
        );
        expect(IdentitySource.catalog(reversed).toJsonText()).toBe(
            IdentitySource.catalog(source).toJsonText(),
        );
        const aliased = source
            .replace('WpMcpTool,', 'WpMcpTool as PublishTool,')
            .replaceAll('@WpMcpTool(', '@PublishTool(');
        expect(IdentitySource.catalog(aliased).toJsonText()).toBe(
            IdentitySource.catalog(source).toJsonText(),
        );
        const qualified = source
            .replace(
                "import 'reflect-metadata';",
                "import 'reflect-metadata';\nimport * as wp from '@webpieces/core-util';",
            )
            .replaceAll('@WpMcpTool(', '@wp.WpMcpTool(');
        expect(IdentitySource.catalog(qualified).toJsonText()).toBe(
            IdentitySource.catalog(source).toJsonText(),
        );
    });

    it.each(['default', 'another'])(
        'refuses a repeated name even with disjoint memberships: %s',
        (profile: string) => {
            const source = fs
                .readFileSync(FIXTURE, 'utf8')
                .replace(
                    "@WpMcpTool('aideveloper_list_issues', { profiles: ['aideveloper'] })",
                    `@WpMcpTool('bugfixer_list_issues', { profiles: ['${profile}'] })`,
                );
            expect(() => IdentitySource.catalog(source)).toThrow(
                /Duplicate @WpMcpTool name 'bugfixer_list_issues'/,
            );
        },
    );

    it('validates every identity profile, including the second declaration', () => {
        const source = fs
            .readFileSync(FIXTURE, 'utf8')
            .replace("profiles: ['aideveloper']", "profiles: ['Invalid/Profile']");
        expect(() => IdentitySource.catalog(source)).toThrow(/profile identifiers must match/);
    });
});
