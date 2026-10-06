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
            import { Binder } from './Binder';
            export interface BindModule { configure(binder: Binder): void | Promise<void>; }
            export interface RouteModule { configure(router: WebpiecesRouter): void; }
            export interface Wiring { getBindModules(): BindModule[]; getRouteModules(): RouteModule[]; }
            export interface AppWiring extends Wiring { getWirings(): Wiring[]; }
            export class FilterDefinition { constructor(public priority: number, public filter: object, public glob: string) {} }
            export class WebpiecesRouter { addRoutes(api: object, implementation: object): void {} addFilter(filter: FilterDefinition): void {} }
            export class WiringPolicy { constructor(public name: string, public enabled: boolean) {} }
        `);
        this.write('packages/http/http-routing', 'Binder.ts', `
            import { BindingTarget } from '../../../../node_modules/inversify/index';
            export class ClientBindOptions { constructor(public token?: unknown, public filters?: object[]) {} }
            export class PubSubBindOptions { constructor(public token?: unknown) {} }
            export interface Binder {
                bind<T>(token: unknown): BindingTarget;
                createRpcClientAndBind(api: object, deployment: string, options?: ClientBindOptions): void;
                createPubSubClientAndBind(api: object, deployment: string, options?: PubSubBindOptions): void;
                bindExternal(api: object, impl: new (...args: never[]) => object): void;
            }
        `);
        this.write('packages/http/http-client-browser', 'Wiring.ts', `
            export class ClientBindOptions { constructor(public token?: unknown) {} }
            export abstract class ExternalImpl<T extends object> { declare readonly implementation: T; }
            export class UseClass<T extends object> extends ExternalImpl<T> { constructor(public useClass: new (...args: never[]) => T) { super(); } }
            export class UseExisting<T extends object> extends ExternalImpl<T> { constructor(public useExisting: abstract new (...args: never[]) => T) { super(); } }
            export class Binder {
                provide(...recipes: unknown[]): void {}
                createRpcClientAndBind(api: object, deployment: string, options?: ClientBindOptions): void {}
                bindExternal<T extends object>(api: abstract new (...args: never[]) => T, impl: ExternalImpl<T>): void {}
            }
            export interface BindModule { configure(binder: Binder): void; }
            export interface Wiring { getBindModules(): BindModule[]; }
            export interface AppWiring extends Wiring { getWirings(): Wiring[]; }
        `);
        this.write('contracts', 'api.ts', 'export function PubSub(): (target: object) => void { return () => undefined; } export class SaveApi {} export class AuthApi {} @PubSub() export class TaskApi {}');
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
        return `import { AppWiring, Wiring, BindModule, RouteModule, WebpiecesRouter, WiringPolicy, FilterDefinition } from '../../packages/http/http-routing/src/Wiring';
            import { Binder, ClientBindOptions, PubSubBindOptions } from '../../packages/http/http-routing/src/Binder';
            import {
                AppWiring as BrowserAppWiring, Wiring as BrowserWiring, BindModule as BrowserBindModule,
                Binder as BrowserBinder, ClientBindOptions as BrowserClientBindOptions, UseClass, UseExisting,
            } from '../../packages/http/http-client-browser/src/Wiring';
            import { ContainerModule, ResolutionContext } from '../../node_modules/inversify/index';
            import { makeEnvironmentProviders, provideAppInitializer } from '../../node_modules/@angular/core/index';
            import { SaveApi, AuthApi, TaskApi } from '../../contracts/src/api';
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

