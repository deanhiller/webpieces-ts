import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Fixture } from './__tests__/wiring-fixture';
import { LangWiring } from './__tests__/lang-wiring';
import { WiringFormat } from './wiring-format';
import { WorkspaceWiringFormat } from './workspace-format';

const valid = `export class Routes implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(SaveApi, SaveApi); } }
export class Library implements Wiring {
    getBindingModules(): BindingModule[] { return []; }
    getRoutingModules(): RouteModule[] { return [new Routes()]; }
}
export class Application implements AppWiring {
    getBindingModules(): BindingModule[] { return []; }
    getRoutingModules(): RouteModule[] { return []; }
    getWirings(): Wiring[] { return [new Library()]; }
}`;

describe('one canonical wiring-format rule', () => {
    it('accepts minimal application/library topology with independent module channels', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(valid));
        expect(fixture.format()).toEqual([]);
    });

    it.each([
        ['spread', 'return [...modules];'],
        ['helper', 'return helper();'],
        ['delegation', 'return parent.getWirings();'],
        ['intermediate arrays', 'const modules = []; return modules;'],
        ['conditional arrays', 'return flag ? [] : [];'],
        ['nested arrays', 'return [[]];'],
        ['wrong channel', 'return [new Routes()];'],
        ['app child cast', 'return [new Application() as Wiring];'],
        ['inline callback', 'return [new ContainerModule(() => {})];'],
        ['nested options', 'return [new ServerWiringOptions([], [])];'],
        ['computed prepared argument', 'return [new Library(discoverConfig().auth)];'],
    ])('reports %s with a source location', (_name, getter) => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(valid.replace('return [new Library()];', getter)));
        expect(fixture.format().join('\n')).toMatch(/wiring.ts:\d+:\d+:/);
    });

    it.each([
        'export function hidden() { return []; }',
        'export const raw = new ContainerModule(() => {});',
        'export class Business { run() { return 1; } }',
        'export class Library2 implements Wiring { getBindingModules() { return []; } getRoutingModules() { return []; } getWirings() { return []; } }',
        'export class Old { getRuntimeWiring() { return new ServerWiring(); } }',
        'export class Hidden implements BindingModule { constructor() { bootstrap(); } configure(options: object) { options.bind(SaveApi); } }',
        'export class Hidden implements BindingModule { configure(options: object) { hidden(options.bind(SaveApi)); } }',
        'export class Hidden implements BindingModule { configure(options: object) { for (const item of items) { options.bind(item); } } }',
    ])('rejects setup, old authoring and hidden composition: %s', (source) => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(valid + source));
        expect(fixture.format().length).toBeGreaterThan(0);
    });

    it('checks the agreed 400-line bound without advising registrations to move, exempting non-wiring files', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(valid + '\n'.repeat(420) + '// too long'));
        fixture.write('app', 'implementation.ts', 'export function arbitrary() { return new ContainerModule(() => {}); }');
        const report = fixture.format().join('\n');
        expect(report).toMatch(/wiring\.ts has \d+ lines, above maxLines 400\. Keep every BindingModule\/RouteModule and its registrations here beside the Wiring class/);
        expect(report).not.toMatch(/move implementations to imported named modules|move (?:the )?(?:modules|registrations|bindings) (?:out|away|to)/i);
        const program = fixture.program();
        const other = program.getSourceFiles().find((file: ts.SourceFile) => file.fileName.endsWith('implementation.ts'))!;
        expect(new WiringFormat(program.getTypeChecker(), 400).problems(other)).toEqual([]);
    });

    it('reports unchanged canonical violations from every participating owner in one failure', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source('export function hidden() {}'));
        fixture.write('library', 'wiring.ts', fixture.source('export const hidden = [];'));
        expect(() => new WorkspaceWiringFormat().assert(fixture.root, fixture.infos, 400)).toThrow(/app.*wiring.ts.*\n.*library.*wiring.ts/s);
    });
});

describe('#1146: modules and their registrations live in wiring.ts', () => {
    const application = `export class Application implements AppWiring {
        getWirings(): Wiring[] { return []; }
        getBindingModules(): BindingModule[] { return [new Clients()]; }
        getRoutingModules(): RouteModule[] { return [new Routes()]; }
    }`;
    const modules = `export class Clients implements BindingModule {
        configure(options: ContainerModuleLoadOptions): void { new RuntimeClients(options).bindRpc(SaveApi, SaveApi, 'store'); }
    }
    export class Routes implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }`;

    it.each(['RuntimeModules.ts', 'BrowserSetup.ts'])('rejects selected modules declared in %s, naming the owning file', (file: string) => {
        const fixture = new Fixture();
        fixture.write('app', file, fixture.source(modules));
        fixture.write('app', 'wiring.ts', fixture.source(`import { Clients, Routes } from './${file.replace('.ts', '')}';\n${application}`));
        const report = fixture.format().join('\n');
        expect(report).toMatch(new RegExp(`Clients is declared in .*${file}; declare this BindingModule class, with its registrations, here in wiring\\.ts`));
        expect(report).toMatch(new RegExp(`Routes is declared in .*${file}; declare this RouteModule class, with its registrations, here in wiring\\.ts`));
    });

    it('rejects selection getters or configure inherited from another file', () => {
        const fixture = new Fixture();
        fixture.write('app', 'RuntimeModules.ts', fixture.source(`
            export class Prepared { getWirings(): Wiring[] { return []; } getBindingModules(): BindingModule[] { return []; } getRoutingModules(): RouteModule[] { return []; } }
            export class BaseRoutes { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }`));
        fixture.write('app', 'wiring.ts', fixture.source(`import { Prepared, BaseRoutes } from './RuntimeModules';
            export class Routes extends BaseRoutes implements RouteModule {}
            export class Application extends Prepared implements AppWiring {}`));
        const report = fixture.format().join('\n');
        expect(report).toMatch(/getBindingModules is inherited from .*RuntimeModules\.ts/);
        expect(report).toMatch(/configure is inherited from .*RuntimeModules\.ts/);
    });

    it('accepts the actual node registrations: DI chains, short DI factories, task/rpc clients, filters and module loads', () => {
        const fixture = new Fixture();
        fixture.write('lib', 'modules.ts', `import { ContainerModule } from '../../node_modules/inversify/index';
            export function createVendorModule(config: object): ContainerModule { return new ContainerModule(() => undefined); }
            export class VendorModule extends ContainerModule { constructor(config: object) { super(() => undefined); } }`);
        fixture.write('app', 'support.ts', `import { ContainerModule } from '../../node_modules/inversify/index';
            export const LocalModule = new ContainerModule(() => undefined);
            export class AppSecrets { static fromEnvironment(): object { return {}; } }
            export class Hook {} export class Filter {} export const TOKEN = Symbol.for('token');`);
        fixture.write('app', 'wiring.ts', fixture.source(`import { createVendorModule, VendorModule } from '../../lib/src/modules';
            import { LocalModule, AppSecrets, Hook, Filter, TOKEN } from './support';
            export class Clients implements BindingModule {
                constructor(private readonly config: { vendor: object; value: object }) {}
                async configure(options: ContainerModuleLoadOptions): Promise<void> {
                    options.bind(TOKEN).to(Hook).inSingletonScope();
                    options.bind<object>(Hook).toSelf().inSingletonScope();
                    options.bind(SaveApi).toConstantValue(this.config.value);
                    options.bind(AuthApi).toDynamicValue((ctx: ResolutionContext) => ctx.get(TOKEN)).inSingletonScope();
                    options.bind(Filter).toDynamicValue(AppSecrets.fromEnvironment).inSingletonScope();
                    const clients = new RuntimeClients(options);
                    clients.bindRpc(SaveApi, SaveApi, 'store');
                    new RuntimeTaskClients(options).bindPubSub(AuthApi, AuthApi, 'worker');
                    new ExternalContractUse('vendor#VendorApi');
                    await LocalModule.load(options);
                    await createVendorModule(this.config.vendor).load(options);
                    await new VendorModule(this.config.vendor).load(options);
                }
            }
            export class Routes implements RouteModule {
                constructor(private readonly policy: WiringPolicy) {}
                configure(router: WebpiecesRouter): void {
                    router.addFilter(new FilterDefinition(1850, Filter, '*'));
                    if (this.policy.enabled) router.addRoutes(AuthApi, AuthApi);
                }
            }
            export class Application implements AppWiring {
                constructor(private readonly config: { vendor: object; value: object }) {}
                getWirings(): Wiring[] { return []; }
                getBindingModules(): BindingModule[] { return [new Clients(this.config)]; }
                getRoutingModules(): RouteModule[] { return [new Routes(new WiringPolicy('admin', true))]; }
            }`));
        expect(fixture.format()).toEqual([]);
    });

    it('accepts Angular provider recipes with named factories and initializers beside browser clients', () => {
        const fixture = new Fixture();
        fixture.write('ui-lib', 'index.ts', 'export function provideI18n(initial: object): object { return {}; } export class SchemePreference { initial(): string { return "light"; } }');
        fixture.write('app', 'BrowserSetup.ts', `export class NavigationData { build(): object { return {}; } }
            export class NavigationService {} export class AppNavigationService {} export class ChromeText {}
            export function chrome(text: ChromeText): object { return {}; } export function initializeSession(): void {}
            export const ICON_PROVIDERS: object[] = []; export const NAVIGATION = Symbol.for('nav'); export const VERSION = Symbol.for('version');`);
        fixture.write('app', 'wiring.ts', fixture.source(`import { provideI18n, SchemePreference } from '../../ui-lib/src/index';
            import { NavigationData, NavigationService, AppNavigationService, ChromeText, chrome, initializeSession, ICON_PROVIDERS, NAVIGATION, VERSION } from './BrowserSetup';
            export class AppBindings implements BindingModule {
                constructor(private readonly initial: object) {}
                configure(bindings: BrowserBindings): void {
                    bindings.add(
                        makeEnvironmentProviders([
                            { provide: NAVIGATION, useFactory: (data: NavigationData): object => data.build(), deps: [NavigationData] },
                            { provide: NavigationService, useClass: AppNavigationService },
                            { provide: VERSION, useValue: '1.0.0' },
                            { provide: ChromeText, useFactory: chrome, deps: [ChromeText], multi: true },
                            { provide: AppNavigationService, useExisting: NavigationService },
                            provideI18n(this.initial),
                            { provide: SchemePreference, useValue: new SchemePreference().initial() },
                            ...ICON_PROVIDERS,
                            provideAppInitializer(initializeSession),
                        ]),
                    );
                    bindings.add(provideRpcClient(SaveApi, SaveApi, 'store'), provideRpcClient(AuthApi, AuthApi, 'store'));
                }
            }
            export class Application implements AppWiring {
                constructor(private readonly initial: object) {}
                getWirings(): Wiring[] { return []; }
                getBindingModules(): BindingModule[] { return [new AppBindings(this.initial)]; }
                getRoutingModules(): RouteModule[] { return []; }
            }`));
        expect(fixture.format()).toEqual([]);
    });

    it.each([
        ['a block-bodied DI factory', 'options.bind(SaveApi).toDynamicValue((ctx: ResolutionContext) => { audit(); return ctx.get(AuthApi); });'],
        ['an inline initializer body', 'options.bind(SaveApi).toConstantValue(provideAppInitializer(() => { startTranslations(); }));'],
        ['an owner helper returning a whole provider list', 'options.bind(SaveApi).toConstantValue(hiddenProviders());'],
        ['an environment read', "options.bind(SaveApi).toConstantValue(process.env['SECRET']);"],
        ['an environment property path', 'options.bind(SaveApi).toConstantValue(window.location);'],
        ['computed configuration', "options.bind(SaveApi).toConstantValue(this.base + '/api');"],
        ['a translation template', 'options.bind(SaveApi).toConstantValue(`${this.locale}-messages`);'],
        ['a loop', 'for (const api of [SaveApi, AuthApi]) options.bind(api).toSelf();'],
        ['a non-policy branch', 'if (this.base) options.bind(SaveApi).toSelf();'],
        ['an else branch', 'if (this.policy.enabled) options.bind(SaveApi).toSelf(); else options.bind(AuthApi).toSelf();'],
        ['an anonymous ContainerModule load', 'await new ContainerModule(() => undefined).load(options);'],
        ['a promise chain hiding work', 'LocalModule.load(options).then(hiddenProviders);'],
        ['a subscription body', 'options.bind(SaveApi).toConstantValue(subscribe((event: object) => { handle(event); }));'],
        ['an arbitrary statement', 'console.log(SaveApi);'],
    ])('rejects %s inside configure', (_name: string, statement: string) => {
        const fixture = new Fixture();
        fixture.write('app', 'support.ts', `import { ContainerModule } from '../../node_modules/inversify/index';
            export const LocalModule = new ContainerModule(() => undefined);
            export function hiddenProviders(): object[] { return []; }
            export function subscribe(handler: (event: object) => void): object { return {}; }
            export function handle(event: object): void {} export function audit(): void {} export function startTranslations(): void {}`);
        fixture.write('app', 'wiring.ts', fixture.source(`import { LocalModule, hiddenProviders, subscribe, handle, audit, startTranslations } from './support';
            export class Clients implements BindingModule {
                constructor(private readonly base: string, private readonly locale: string, private readonly policy: WiringPolicy) {}
                async configure(options: ContainerModuleLoadOptions): Promise<void> {
                    ${statement}
                }
            }
            export class Routes implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindingModules(): BindingModule[] { return [new Clients('base', 'en', new WiringPolicy('p', true))]; }
                getRoutingModules(): RouteModule[] { return [new Routes()]; }
            }`));
        expect(fixture.format().join('\n')).toMatch(/wiring\.ts:\d+:\d+: .*(?:configure contains only|recognized registration|declarative registration arguments|Removed topology shape)/);
    });

    it('accepts the complete Lang-sized server wiring.ts under the 400-line bound', () => {
        const fixture = new Fixture();
        const source = new LangWiring().install(fixture);
        const lines = source.trimEnd().split('\n').length;
        expect(lines).toBeGreaterThan(260);
        expect(lines).toBeLessThanOrEqual(400);
        expect(fixture.format()).toEqual([]);
    });
});
