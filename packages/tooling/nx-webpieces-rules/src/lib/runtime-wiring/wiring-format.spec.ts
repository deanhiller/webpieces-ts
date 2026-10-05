import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Fixture } from './__tests__/wiring-fixture';
import { LangWiring } from './__tests__/lang-wiring';
import { WiringFormat } from './wiring-format';
import { WorkspaceWiringFormat } from './workspace-format';
import { ResolvedWiringRelationship, RuntimeWiringAssembler } from './assembler';
import type { RuntimeDeclaration } from './declaration';
import * as path from 'path';

const valid = `export class Routes implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(SaveApi, SaveApi); } }
export class Library implements Wiring {
    getBindModules(): BindModule[] { return []; }
    getRouteModules(): RouteModule[] { return [new Routes()]; }
}
export class Application implements AppWiring {
    getBindModules(): BindModule[] { return []; }
    getRouteModules(): RouteModule[] { return []; }
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
        'export class Library2 implements Wiring { getBindModules() { return []; } getRouteModules() { return []; } getWirings() { return []; } }',
        'export class Old { getRuntimeWiring() { return new ServerWiring(); } }',
        'export class Hidden implements BindModule { constructor() { bootstrap(); } configure(binder: Binder) { binder.bind(SaveApi); } }',
        'export class Hidden implements BindModule { configure(binder: Binder) { hidden(binder.bind(SaveApi)); } }',
        'export class Hidden implements BindModule { configure(binder: Binder) { for (const item of items) { binder.bind(item); } } }',
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
        expect(report).toMatch(/wiring\.ts has \d+ lines, above maxLines 400\. Keep every BindModule\/RouteModule and its registrations here beside the Wiring class/);
        expect(report).not.toMatch(/move implementations to imported named modules|move (?:the )?(?:modules|registrations|bindings) (?:out|away|to)/i);
        const program = fixture.program();
        const other = program.getSourceFiles().find((file: ts.SourceFile) => file.fileName.endsWith('implementation.ts'))!;
        expect(new WiringFormat(program.getTypeChecker(), 400).problems(other)).toEqual([]);
    });

    it('names the renamed getters and the retired module contract', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(valid.replace('getBindModules(): BindModule[] { return []; }\n    getRouteModules(): RouteModule[] { return []; }\n    getWirings', 'getBindingModules(): BindModule[] { return []; }\n    getRoutingModules(): RouteModule[] { return []; }\n    getWirings')));
        const report = fixture.format().join('\n');
        expect(report).toMatch(/getBindingModules was renamed to getBindModules/);
        expect(report).toMatch(/getRoutingModules was renamed to getRouteModules/);
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
        getBindModules(): BindModule[] { return [new Clients()]; }
        getRouteModules(): RouteModule[] { return [new Routes()]; }
    }`;
    const modules = `export class Clients implements BindModule {
        configure(binder: Binder): void { binder.createRpcClientAndBind(SaveApi, 'store'); }
    }
    export class Routes implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }`;

    it.each(['RuntimeModules.ts', 'BrowserSetup.ts'])('rejects selected modules declared in %s, naming the owning file', (file: string) => {
        const fixture = new Fixture();
        fixture.write('app', file, fixture.source(modules));
        fixture.write('app', 'wiring.ts', fixture.source(`import { Clients, Routes } from './${file.replace('.ts', '')}';\n${application}`));
        const report = fixture.format().join('\n');
        expect(report).toMatch(new RegExp(`Clients is declared in .*${file}; declare this BindModule class, with its registrations, here in wiring\\.ts`));
        expect(report).toMatch(new RegExp(`Routes is declared in .*${file}; declare this RouteModule class, with its registrations, here in wiring\\.ts`));
    });

    it('rejects selection getters or configure inherited from another file', () => {
        const fixture = new Fixture();
        fixture.write('app', 'RuntimeModules.ts', fixture.source(`
            export class Prepared { getWirings(): Wiring[] { return []; } getBindModules(): BindModule[] { return []; } getRouteModules(): RouteModule[] { return []; } }
            export class BaseRoutes { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }`));
        fixture.write('app', 'wiring.ts', fixture.source(`import { Prepared, BaseRoutes } from './RuntimeModules';
            export class Routes extends BaseRoutes implements RouteModule {}
            export class Application extends Prepared implements AppWiring {}`));
        const report = fixture.format().join('\n');
        expect(report).toMatch(/getBindModules is inherited from .*RuntimeModules\.ts/);
        expect(report).toMatch(/configure is inherited from .*RuntimeModules\.ts/);
    });

    it('accepts the actual node registrations: binder DI chains, short DI factories, clients created and bound, vendor binds and filters', () => {
        const fixture = new Fixture();
        fixture.write('vendor', 'api.ts', 'export abstract class VendorApi { abstract call(): void; } export class VendorClient extends VendorApi { call(): void {} }');
        fixture.write('app', 'support.ts', `export class AppSecrets { static fromEnvironment(): object { return {}; } }
            export class Hook {} export class Filter {} export const TOKEN = Symbol.for('token'); export const SECOND = Symbol.for('second');`);
        fixture.write('app', 'wiring.ts', fixture.source(`import { VendorApi, VendorClient } from '../../vendor/src/api';
            import { AppSecrets, Hook, Filter, TOKEN, SECOND } from './support';
            export class Clients implements BindModule {
                constructor(private readonly config: { value: object; filters: object[] }) {}
                async configure(binder: Binder): Promise<void> {
                    binder.bind(TOKEN).to(Hook).inSingletonScope();
                    binder.bind<object>(Hook).toSelf().inSingletonScope();
                    binder.bind(SaveApi).toConstantValue(this.config.value);
                    binder.bind(AuthApi).toDynamicValue((ctx: ResolutionContext) => ctx.get(TOKEN)).inSingletonScope();
                    binder.bind(Filter).toDynamicValue(AppSecrets.fromEnvironment).inSingletonScope();
                    binder.createRpcClientAndBind(SaveApi, 'store');
                    binder.createRpcClientAndBind(SaveApi, 'second-store', new ClientBindOptions(SECOND, this.config.filters));
                    binder.createPubSubClientAndBind(TaskApi, 'worker', new PubSubBindOptions(TOKEN));
                    binder.bindExternal(VendorApi, VendorClient);
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
                constructor(private readonly config: { value: object; filters: object[] }) {}
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients(this.config)]; }
                getRouteModules(): RouteModule[] { return [new Routes(new WiringPolicy('admin', true))]; }
            }`));
        expect(fixture.format()).toEqual([]);
    });

    it('accepts a library canonical wiring.ts that exports only BindModules', () => {
        const fixture = new Fixture();
        fixture.write('vendor', 'api.ts', 'export abstract class VendorApi { abstract call(): void; } export class VendorClient extends VendorApi { call(): void {} }');
        fixture.write('vendor', 'wiring.ts', fixture.source(`import { VendorApi, VendorClient } from './api';
            export class VendorBindModule implements BindModule {
                constructor(private readonly config: object) {}
                configure(binder: Binder): void {
                    binder.bind(SaveApi).toConstantValue(this.config);
                    binder.bindExternal(VendorApi, VendorClient);
                }
            }`));
        const program = fixture.program();
        const file = program.getSourceFile(path.join(fixture.root, 'vendor/src/wiring.ts'))!;
        expect(new WiringFormat(program.getTypeChecker(), 400).problems(file)).toEqual([]);
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
            export class AppBindings implements BrowserBindModule {
                constructor(private readonly initial: object) {}
                configure(binder: BrowserBinder): void {
                    binder.provide(
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
                    binder.createRpcClientAndBind(SaveApi, 'store');
                    binder.createRpcClientAndBind(AuthApi, 'store', new BrowserClientBindOptions(NAVIGATION));
                }
            }
            export class Application implements BrowserAppWiring {
                constructor(private readonly initial: object) {}
                getWirings(): BrowserWiring[] { return []; }
                getBindModules(): BrowserBindModule[] { return [new AppBindings(this.initial)]; }
            }`));
        expect(fixture.format()).toEqual([]);
    });

    it.each([
        ['a block-bodied DI factory', 'binder.bind(SaveApi).toDynamicValue((ctx: ResolutionContext) => { audit(); return ctx.get(AuthApi); });'],
        ['an inline initializer body', 'binder.bind(SaveApi).toConstantValue(provideAppInitializer(() => { startTranslations(); }));'],
        ['an owner helper returning a whole provider list', 'binder.bind(SaveApi).toConstantValue(hiddenProviders());'],
        ['an environment read', "binder.bind(SaveApi).toConstantValue(process.env['SECRET']);"],
        ['an environment property path', 'binder.bind(SaveApi).toConstantValue(window.location);'],
        ['computed configuration', "binder.bind(SaveApi).toConstantValue(this.base + '/api');"],
        ['a translation template', 'binder.bind(SaveApi).toConstantValue(`${this.locale}-messages`);'],
        ['a loop', 'for (const api of [SaveApi, AuthApi]) binder.bind(api).toSelf();'],
        ['a non-policy branch', 'if (this.base) binder.bind(SaveApi).toSelf();'],
        ['an else branch', 'if (this.policy.enabled) binder.bind(SaveApi).toSelf(); else binder.bind(AuthApi).toSelf();'],
        ['an anonymous ContainerModule load', 'await new ContainerModule(() => undefined).load(binder);'],
        ['an opaque named module load', 'await LocalModule.load(binder);'],
        ['a promise chain hiding work', 'LocalModule.load(binder).then(hiddenProviders);'],
        ['a retired RuntimeClients helper', "new RuntimeClients(binder).bindRpc(SaveApi, SaveApi, 'store');"],
        ['a retired ExternalContractUse marker', "new ExternalContractUse('vendor#VendorApi');"],
        ['a retired provideRpcClient recipe', "binder.bind(SaveApi).toConstantValue(provideRpcClient(SaveApi, SaveApi, 'store'));"],
        ['a subscription body', 'binder.bind(SaveApi).toConstantValue(subscribe((event: object) => { handle(event); }));'],
        ['an arbitrary statement', 'console.log(SaveApi);'],
    ])('rejects %s inside configure', (_name: string, statement: string) => {
        const fixture = new Fixture();
        fixture.write('app', 'support.ts', `import { ContainerModule } from '../../node_modules/inversify/index';
            export const LocalModule = new ContainerModule(() => undefined);
            export function hiddenProviders(): object[] { return []; }
            export function subscribe(handler: (event: object) => void): object { return {}; }
            export function handle(event: object): void {} export function audit(): void {} export function startTranslations(): void {}
            export class RuntimeClients { constructor(options: object) {} bindRpc(token: object, api: object, target: string): void {} }
            export class ExternalContractUse { constructor(identity: string) {} }
            export function provideRpcClient(token: object, api: object, target: string): object { return {}; }`);
        fixture.write('app', 'wiring.ts', fixture.source(`import { LocalModule, hiddenProviders, subscribe, handle, audit, startTranslations, RuntimeClients, ExternalContractUse, provideRpcClient } from './support';
            export class Clients implements BindModule {
                constructor(private readonly base: string, private readonly locale: string, private readonly policy: WiringPolicy) {}
                async configure(binder: Binder): Promise<void> {
                    ${statement}
                }
            }
            export class Routes implements RouteModule { configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); } }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients('base', 'en', new WiringPolicy('p', true))]; }
                getRouteModules(): RouteModule[] { return [new Routes()]; }
            }`));
        expect(fixture.format().join('\n')).toMatch(/wiring\.ts:\d+:\d+: .*(?:configure contains only|recognized registration|declarative registration arguments|Removed topology shape)/);
    });

    it('accepts the complete Lang server wiring.ts, selecting library BindModules in one line, under the 200-line bound', () => {
        const fixture = new Fixture();
        const source = new LangWiring().install(fixture);
        const lines = source.trimEnd().split('\n').length;
        expect(lines).toBeGreaterThan(150);
        expect(lines).toBeLessThanOrEqual(200);
        expect(fixture.format()).toEqual([]);
        const declarations = new Map(['app', 'server-auth', 'company', 'lesson-rules', 'lib-gcp-storage', 'lib-gcp-tts']
            .map((project: string): [string, RuntimeDeclaration] => [project, fixture.extract(project)]));
        const assembled = new RuntimeWiringAssembler(declarations).assemble('app');
        const external = assembled.filter((relationship: ResolvedWiringRelationship) => relationship.transport === 'external');
        expect(external.map((relationship: ResolvedWiringRelationship) => `${relationship.owner}#${relationship.api}`))
            .toEqual(['lib-gcp-storage#StorageApi', 'lib-gcp-tts#TextToSpeechApi']);
        expect(assembled.filter((relationship: ResolvedWiringRelationship) => relationship.direction === 'uses' && relationship.transport === 'rpc')).toHaveLength(7);
        expect(assembled.filter((relationship: ResolvedWiringRelationship) => relationship.direction === 'uses' && relationship.transport === 'pubsub')).toHaveLength(2);
    });
});
