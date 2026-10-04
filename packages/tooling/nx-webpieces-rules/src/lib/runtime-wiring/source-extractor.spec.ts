import { describe, expect, it } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ProjectInfo } from '../project-info';
import { WiringSourceExtractor } from './source-extractor';

class Fixture {
    readonly root = specTempDirs.make('runtime-wiring-');
    readonly infos = new Map<string, ProjectInfo>();
    readonly files: string[] = [];

    constructor() {
        this.write(
            'contracts',
            'api.ts',
            'export class SaveApi {}\nexport interface VendorApi { send(): void; }',
        );
    }

    write(project: string, file: string, source: string): void {
        const target = path.join(this.root, project, 'src', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
        this.files.push(target);
        this.infos.set(
            project,
            new ProjectInfo(
                project,
                project,
                project === 'app' ? ['webpieces', 'framework:node'] : ['webpieces-lib'],
            ),
        );
    }

    extract(): ReturnType<WiringSourceExtractor['extract']> {
        const program = ts.createProgram(this.files, {
            target: ts.ScriptTarget.ES2022,
            moduleResolution: ts.ModuleResolutionKind.Node10,
        });
        return new WiringSourceExtractor(
            this.root,
            this.infos.get('app')!,
            this.infos,
            program,
        ).extract();
    }

    plan(body: string, extras: string = ''): void {
        this.write(
            'app',
            'wiring.ts',
            `
            import { SaveApi } from '../../contracts/src/api';
            class ServerWiring { constructor(host: string, options: ServerWiringOptions) {} }
            class ServerWiringOptions { constructor(bindings: unknown[], routes: unknown[]) {} }
            class RuntimeClients { bindRpc(token: unknown, api: unknown, target: string) {} }
            class WiringPolicy { constructor(name: string, public enabled: boolean) {} }
            export class Clients { constructor(public policy: WiringPolicy) { ${body} } }
            export class App { getRuntimeWiring() { return new ServerWiring('app', new ServerWiringOptions([new Clients(new WiringPolicy('warmup', process.env.WARMUP === '1'))], [])); } }
            ${extras}
        `,
        );
    }
}

describe('build-only canonical wiring extraction', () => {
    it('resolves qualified imported contracts without running constructors', () => {
        const fixture = new Fixture();
        fixture.plan(
            "new RuntimeClients().bindRpc(Symbol(), SaveApi, 'save'); throw new Error('must never execute');",
        );
        const result = fixture.extract();
        expect(result.exports.Clients.relationships[0]).toMatchObject({
            contract: { project: 'contracts', exportedName: 'SaveApi' },
            target: { kind: 'service', service: 'save' },
        });
        expect(result.exports.App.selections[0].policies).toEqual({ policy: 'runtime' });
    });

    it('retains named runtime conditions', () => {
        const fixture = new Fixture();
        fixture.plan(
            "if (this.policy.enabled) { new RuntimeClients().bindRpc(Symbol(), SaveApi, 'save'); }",
        );
        expect(fixture.extract().exports.Clients.relationships[0].policy).toBe('policy');
    });

    it.each([
        "if (this.policy.enabled) {} else { new RuntimeClients().bindRpc(Symbol(), SaveApi, 'save'); }",
        "if (Math.random()) { new RuntimeClients().bindRpc(Symbol(), SaveApi, 'save'); }",
        "while (false) { new RuntimeClients().bindRpc(Symbol(), SaveApi, 'save'); }",
    ])('rejects unsupported conditional topology: %s', (body) => {
        const fixture = new Fixture();
        fixture.plan(body);
        expect(() => fixture.extract()).toThrow();
    });

    it('rejects topology aliases outside canonical wiring', () => {
        const fixture = new Fixture();
        fixture.plan('');
        fixture.write(
            'app',
            'hidden.ts',
            'class Factory { createRpcClient() {} }; const factory = new Factory(); const alias = factory.createRpcClient;',
        );
        expect(() => fixture.extract()).toThrow('topology method references');
    });
    it('external interface metadata requires a production business caller, not an adapter', () => {
        const fixture = new Fixture();
        fixture.plan(
            "new ExternalContractUse('contracts#VendorApi');",
            'class ExternalContractUse { constructor(contract: string) {} }',
        );
        fixture.write(
            'app',
            'adapter.ts',
            "import { VendorApi } from '../../contracts/src/api'; class Adapter implements VendorApi { constructor(private seam: VendorApi) {} send() {} }",
        );
        expect(() => fixture.extract()).toThrow('no production business consumer');
        fixture.write(
            'app',
            'business.ts',
            "import { VendorApi } from '../../contracts/src/api'; class Business { constructor(private seam: VendorApi) {} }",
        );
        expect(fixture.extract().exports.Clients.relationships).toMatchObject([
            {
                contract: { project: 'contracts', exportedName: 'VendorApi' },
                transport: 'external',
            },
        ]);
    });
});
