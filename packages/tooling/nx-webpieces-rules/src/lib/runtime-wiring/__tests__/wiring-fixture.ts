import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ProjectInfo } from '../../project-info';
import { WiringSourceExtractor } from '../source-extractor';
import { WiringFormat } from '../wiring-format';
export class Fixture {
    readonly root = specTempDirs.make('wiring-v2-');
    readonly infos = new Map<string, ProjectInfo>();
    readonly files: string[] = [];
    readonly framework = '../../../packages/http/http-routing/src/Wiring';

    constructor() {
        this.write('packages/http/http-routing', 'Wiring.ts', `
            export interface BindingModule { configure(options: object): void; }
            export interface RouteModule { configure(router: WebpiecesRouter): void; }
            export interface Wiring { getBindingModules(): BindingModule[]; getRoutingModules(): RouteModule[]; }
            export interface AppWiring extends Wiring { getWirings(): Wiring[]; }
            export class FilterDefinition { constructor(public priority: number, public filter: object, public glob: string) {} }
            export class WebpiecesRouter { addRoutes(api: object, implementation: object): void {} addFilter(filter: FilterDefinition): void {} }
            export class WiringPolicy { constructor(public name: string, public enabled: boolean) {} }
        `);
        this.write('packages/http/http-client-node', 'RuntimeClients.ts', 'export class RuntimeClients { constructor(options?: object) {} bindRpc(token: object, api: object, destination: string): void {} }');
        this.write('packages/cloud/cloudtasks-client', 'RuntimeTaskClients.ts', 'export class RuntimeTaskClients { constructor(options?: object) {} bindPubSub(token: object, api: object, destination: string): void {} }');
        this.write('packages/http/http-client-core', 'ExternalContractUse.ts', 'export class ExternalContractUse { constructor(identity: string) {} }');
        this.write('packages/http/http-client-browser', 'BrowserBindings.ts', `
            export class BrowserBindings { add(...providers: unknown[]): void {} }
            export function provideRpcClient(token: object, api: object, destination: string): object { return {}; }`);
        this.write('contracts', 'api.ts', 'export class SaveApi {} export class AuthApi {}');
        this.vendor('inversify', `
            export class ResolutionContext { get<T>(token: unknown): T { return token as T; } }
            export class BindingScope { inSingletonScope(): void {} }
            export class BindingTarget {
                to(type: object): BindingScope { return new BindingScope(); }
                toSelf(): BindingScope { return new BindingScope(); }
                toConstantValue(value: unknown): BindingScope { return new BindingScope(); }
                toDynamicValue(factory: (context: ResolutionContext) => unknown): BindingScope { return new BindingScope(); }
            }
            export class ContainerModuleLoadOptions { bind<T>(token: unknown): BindingTarget { return new BindingTarget(); } }
            export class ContainerModule {
                constructor(callback: (options: ContainerModuleLoadOptions) => void) {}
                load(options: ContainerModuleLoadOptions): Promise<void> { return Promise.resolve(); }
            }`);
        this.vendor('@angular/core', `
            export class EnvironmentProviders {}
            export function makeEnvironmentProviders(providers: unknown[]): EnvironmentProviders { return new EnvironmentProviders(); }
            export function provideAppInitializer(initializer: () => unknown): EnvironmentProviders { return new EnvironmentProviders(); }`);
    }

    /** A vendor package outside every owner, resolved through a node_modules path like a real install. */
    vendor(name: string, source: string): void {
        const target = path.join(this.root, 'node_modules', name, 'index.ts');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
        this.files.push(target);
    }

    write(project: string, file: string, source: string): void {
        const target = path.join(this.root, project, 'src', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
        this.files.push(target);
        this.infos.set(project, new ProjectInfo(project, project, project === 'app' ? ['webpieces', 'framework:node'] : ['webpieces-lib']));
    }

    source(body: string): string {
        return `import { AppWiring, Wiring, BindingModule, RouteModule, WebpiecesRouter, WiringPolicy, FilterDefinition } from '../../packages/http/http-routing/src/Wiring';
            import { RuntimeClients } from '../../packages/http/http-client-node/src/RuntimeClients';
            import { RuntimeTaskClients } from '../../packages/cloud/cloudtasks-client/src/RuntimeTaskClients';
            import { ExternalContractUse } from '../../packages/http/http-client-core/src/ExternalContractUse';
            import { BrowserBindings, provideRpcClient } from '../../packages/http/http-client-browser/src/BrowserBindings';
            import { ContainerModule, ContainerModuleLoadOptions, ResolutionContext } from '../../node_modules/inversify/index';
            import { makeEnvironmentProviders, provideAppInitializer } from '../../node_modules/@angular/core/index';
            import { SaveApi, AuthApi } from '../../contracts/src/api';
            ${body}`;
    }

    program(): ts.Program {
        return ts.createProgram(this.files, { target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Node10 });
    }

    extract(project: string = 'app'): ReturnType<WiringSourceExtractor['extract']> {
        return new WiringSourceExtractor(this.root, this.infos.get(project)!, this.infos, this.program()).extract();
    }

    format(): string[] {
        const program = this.program();
        return new WiringFormat(program.getTypeChecker(), 400).problems(program.getSourceFile(path.join(this.root, 'app/src/wiring.ts'))!);
    }
}

