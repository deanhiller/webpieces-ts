import { describe, expect, it } from 'vitest';
import { Fixture } from './__tests__/wiring-fixture';
import { ResolvedWiringRelationship, RuntimeWiringAssembler } from './assembler';
import { WiringRelationship, WiringSelection } from './declaration';
import { RuntimeDeclarationCodec } from './codec';

const leaf = `export class Clients implements BindModule {
    constructor(private readonly destination: string) {}
    configure(binder: Binder): void { binder.createRpcClientAndBind(SaveApi, this.destination); }
}
export class Routes implements RouteModule {
    configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); }
}`;
const app = `export class Application implements AppWiring {
    getWirings(): Wiring[] { return []; }
    getBindModules(): BindModule[] { return [new Clients('store')]; }
    getRouteModules(): RouteModule[] { return [new Routes()]; }
}`;

describe('typed Wiring/AppWiring extraction', () => {
    it('infers browser destinations through the browser Binder, with no route channel', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(`
            export class BrowserClients implements BrowserBindModule {
                constructor(private readonly store: string) {}
                configure(binder: BrowserBinder): void { binder.createRpcClientAndBind(SaveApi, this.store); }
            }
            export class Application implements BrowserAppWiring {
                getWirings(): BrowserWiring[] { return []; }
                getBindModules(): BrowserBindModule[] { return [new BrowserClients('browser-database')]; }
            }`));
        expect(fixture.format()).toEqual([]);
        const declaration = fixture.extract();
        expect(declaration.exports.Application.bindModules[0].targets).toEqual({ store: { kind: 'service', service: 'browser-database' } });
        expect(declaration.exports.Application.routeModules).toEqual([]);
        expect(new RuntimeWiringAssembler(new Map([['app', declaration]])).assemble('app')).toMatchObject([{ target: { service: 'browser-database' } }]);
    });
    it('forwards a prepared destination and named policy through app, library and module', () => {
        const fixture = new Fixture();
        fixture.write('library', 'wiring.ts', fixture.source(`
            export class Clients implements BindModule {
                constructor(private readonly destination: string, private readonly policy: WiringPolicy) {}
                configure(binder: Binder): void {
                    if (this.policy.enabled) binder.createRpcClientAndBind(SaveApi, this.destination);
                }
            }
            export class Library implements Wiring {
                constructor(private readonly config: { store: string }, private readonly selected: WiringPolicy) {}
                getBindModules(): BindModule[] { return [new Clients(this.config.store, this.selected)]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        fixture.write('app', 'config.ts', "export const prepared = { store: 'database' };");
        fixture.write('app', 'wiring.ts', fixture.source(`
            import { Library } from '../../library/src/wiring';
            import { prepared } from './config';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return [new Library(prepared, new WiringPolicy('public', true))]; }
                getBindModules(): BindModule[] { return []; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        const application = fixture.extract();
        const library = fixture.extract('library');
        const assembler = new RuntimeWiringAssembler(new Map([['app', application], ['library', library]]));
        expect(assembler.assemble('app')).toMatchObject([{ target: { service: 'database' } }]);
        application.exports.Application.wirings[0].policies.selected = false;
        expect(assembler.assemble('app')).toEqual([]);
        application.exports.Application.wirings[0].policies.selected = 'runtime';
        expect(assembler.assemble('app')).toMatchObject([{ conditional: 'library#Clients:policy' }]);
    });
    it('extracts the two ordered module channels, inferring a destination without a name heuristic', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + app));
        expect(fixture.format()).toEqual([]);
        const result = fixture.extract();
        expect(result.schemaVersion).toBe(2);
        expect(result.entry).toBe('Application');
        expect(result.exports.Application.bindModules[0].targets).toEqual({ destination: { kind: 'service', service: 'store' } });
        expect(result.exports.Application.routeModules[0].exportedName).toBe('Routes');
        expect(result.exports.Clients.relationships[0]).toMatchObject({ contract: { project: 'contracts', exportedName: 'SaveApi' }, target: { kind: 'parameter', parameter: 'destination' } });
        expect(new RuntimeDeclarationCodec().decode(JSON.stringify(result), 'app')).toEqual(result);
    });

    it('rejects the retired bindingModules/routingModules field names, naming the new ones', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + app));
        const renamed = JSON.stringify(fixture.extract()).replace(/"bindModules"/g, '"bindingModules"');
        expect(() => new RuntimeDeclarationCodec().decode(renamed, 'app')).toThrow(/bindingModules was renamed to bindModules/);
    });

    it('records both client kinds and keeps two clients of the SAME api apart by token and deployment', () => {
        const fixture = new Fixture();
        fixture.write('app', 'support.ts', "export const FIRST = Symbol.for('first'); export const SECOND = Symbol.for('second');");
        fixture.write('app', 'wiring.ts', fixture.source(`import { FIRST, SECOND } from './support';
            export class Clients implements BindModule {
                configure(binder: Binder): void {
                    binder.createRpcClientAndBind(SaveApi, 'first-store', new ClientBindOptions(FIRST));
                    binder.createRpcClientAndBind(SaveApi, 'second-store', new ClientBindOptions(SECOND));
                    binder.createPubSubClientAndBind(TaskApi, 'worker');
                }
            }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients()]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(fixture.format()).toEqual([]);
        const assembled = new RuntimeWiringAssembler(new Map([['app', fixture.extract()]])).assemble('app');
        expect(assembled.map((relationship: ResolvedWiringRelationship) => `${relationship.api}:${relationship.transport}:${relationship.target?.kind === 'service' ? relationship.target.service : ''}`))
            .toEqual(['SaveApi:rpc:first-store', 'SaveApi:rpc:second-store', 'TaskApi:pubsub:worker']);
    });

    it('rejects a client created with the wrong transport for its contract', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(`
            export class Clients implements BindModule { configure(binder: Binder): void { binder.createPubSubClientAndBind(SaveApi, 'worker'); } }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients()]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(() => fixture.extract()).toThrow(/createPubSubClientAndBind transport disagrees with contracts#SaveApi/);
    });

    it('selects both lists from a library once, retaining repeats with independent destinations and ignoring unselected exports', () => {
        const fixture = new Fixture();
        fixture.write('library', 'wiring.ts', fixture.source(leaf + `
            export class AuthWiring implements Wiring {
                constructor(private readonly store: string) {}
                getBindModules(): BindModule[] { return [new Clients(this.store)]; }
                getRouteModules(): RouteModule[] { return [new Routes()]; }
            }
            export class Unselected implements Wiring {
                getBindModules(): BindModule[] { return [new Clients('unused')]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        fixture.write('library', 'index.ts', "export { AuthWiring as Authentication } from './wiring';");
        fixture.write('app', 'wiring.ts', fixture.source(`import { Authentication as Auth } from '../../library/src/index';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return [new Auth('first'), new Auth('second')]; }
                getBindModules(): BindModule[] { return []; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        const library = fixture.extract('library');
        expect(library.entry).toBeUndefined();
        expect(library.host).toBeUndefined();
        const result = new RuntimeWiringAssembler(new Map([['app', fixture.extract()], ['library', library]])).assemble('app');
        expect(result.map((relationship: ResolvedWiringRelationship) => relationship.api)).toEqual(['SaveApi', 'SaveApi', 'AuthApi', 'AuthApi']);
        expect(result.slice(0, 2).map((relationship: ResolvedWiringRelationship) => relationship.target)).toEqual([{ kind: 'service', service: 'first' }, { kind: 'service', service: 'second' }]);
        expect(result[0].via).toContain('library#AuthWiring');
        expect(result[0].via).toContain('/bindModules[0]:library#Clients');
        expect(result).toHaveLength(4);
    });

    it('never runs module constructors, getters or configure while extracting prepared config paths', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(`import { prepared } from './config';
            export class Clients implements BindModule {
                constructor(private readonly config: { auth: { store: string } }) { throw new Error('must never execute'); }
                configure(binder: Binder): void { binder.createRpcClientAndBind(SaveApi, this.config.auth.store); throw new Error('never'); }
            }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients(prepared)]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        fixture.write('app', 'config.ts', "export const prepared = { auth: { store: 'database', password: 'never-a-graph-target' } };");
        const result = fixture.extract();
        expect(result.exports.Application.bindModules[0].targets).toEqual({ 'config.auth.store': { kind: 'service', service: 'database' } });
        expect(JSON.stringify(result)).not.toContain('never-a-graph-target');
    });

    it('rejects unrelated classes with topology method names without fabricating relationships', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + app));
        fixture.write('app', 'unrelated.ts', 'export class Unrelated { createRpcClientAndBind(a: object, c: string) {} } new Unrelated().createRpcClientAndBind({}, "unrelated");');
        expect(Object.keys(fixture.extract().exports)).not.toContain('Unrelated');
    });

    it.each([
        app.replace("[new Clients('store')]", '[...modules]'),
        app.replace("[new Clients('store')]", '[new Routes()]'),
        app.replace('return [];', 'return [new Application()];'),
        app.replace("return [new Clients('store')];", "const modules = [new Clients('store')]; return modules;"),
        app + app.replace('Application', 'Other'),
    ])('rejects unsupported, wrong-kind and ambiguous topology', (source: string) => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + source));
        expect(() => fixture.extract()).toThrow();
    });
});

describe('#1146/#1150: extraction reads only OWNER-canonical wiring.ts', () => {
    const selecting = (imports: string): string => `${imports}
        export class Application implements AppWiring {
            getWirings(): Wiring[] { return []; }
            getBindModules(): BindModule[] { return [new Clients('store')]; }
            getRouteModules(): RouteModule[] { return [new Routes()]; }
        }`;

    it.each(['RuntimeModules.ts', 'BrowserSetup.ts'])(
        'rejects a selected module declared in %s even though the old broad scan reproduced the same graph',
        (file: string) => {
            const fixture = new Fixture();
            fixture.write('app', file, fixture.source(leaf));
            fixture.write('app', 'wiring.ts', fixture.source(selecting(`import { Clients, Routes } from './${file.replace('.ts', '')}';`)));
            expect(() => fixture.extract()).toThrow(new RegExp(`Application selects Clients, which is declared in .*${file}\\. Declare the BindModule class Clients, with its registrations, beside Application in .*wiring\\.ts, or in its library owner's canonical src/wiring\\.ts`));
        },
    );

    const libraryModule = `export class VendorBindModule implements BindModule {
        constructor(private readonly store: string) {}
        configure(binder: Binder): void { binder.createRpcClientAndBind(SaveApi, this.store); }
    }`;
    const selectingLibrary = (imports: string): string => `${imports}
        export class LocalBindModule implements BindModule { configure(binder: Binder): void { binder.createPubSubClientAndBind(TaskApi, 'worker'); } }
        export class Application implements AppWiring {
            getWirings(): Wiring[] { return []; }
            getBindModules(): BindModule[] { return [new LocalBindModule(), new VendorBindModule('vendor-store')]; }
            getRouteModules(): RouteModule[] { return []; }
        }`;

    it('selects a library BindModule declared in that library\'s canonical wiring.ts in one line, beside a local one', () => {
        const fixture = new Fixture();
        fixture.write('vendor-lib', 'wiring.ts', fixture.source(libraryModule));
        fixture.write('app', 'wiring.ts', fixture.source(selectingLibrary("import { VendorBindModule } from '../../vendor-lib/src/wiring';")));
        expect(fixture.format()).toEqual([]);
        const application = fixture.extract();
        expect(application.exports.Application.bindModules.map((selection: WiringSelection) => `${selection.project}#${selection.exportedName}`))
            .toEqual(['app#LocalBindModule', 'vendor-lib#VendorBindModule']);
        expect(Object.keys(application.exports)).not.toContain('VendorBindModule');
        const library = fixture.extract('vendor-lib');
        expect(library.entry).toBeUndefined();
        expect(Object.keys(library.exports)).toEqual(['VendorBindModule']);
        const assembled = new RuntimeWiringAssembler(new Map([['app', application], ['vendor-lib', library]])).assemble('app');
        expect(assembled.map((relationship: ResolvedWiringRelationship) => `${relationship.api}:${relationship.target?.kind === 'service' ? relationship.target.service : ''}`))
            .toEqual(['TaskApi:worker', 'SaveApi:vendor-store']);
    });

    it('resolves a RE-EXPORTED library BindModule by symbol, not by name', () => {
        const fixture = new Fixture();
        fixture.write('vendor-lib', 'wiring.ts', fixture.source(libraryModule));
        fixture.write('vendor-lib', 'index.ts', "export { VendorBindModule as Renamed } from './wiring';");
        fixture.write('app', 'wiring.ts', fixture.source(selectingLibrary("import { Renamed as VendorBindModule } from '../../vendor-lib/src/index';")));
        expect(fixture.format()).toEqual([]);
        expect(fixture.extract().exports.Application.bindModules[1]).toMatchObject({ project: 'vendor-lib', exportedName: 'VendorBindModule' });
    });

    it('rejects a library BindModule declared in any other file of that library, naming the module and the file', () => {
        const fixture = new Fixture();
        fixture.write('vendor-lib', 'wiring.ts', fixture.source('export class Unrelated implements BindModule { configure(binder: Binder): void {} }'));
        fixture.write('vendor-lib', 'VendorModules.ts', fixture.source(libraryModule));
        fixture.write('vendor-lib', 'index.ts', "export { VendorBindModule } from './VendorModules';");
        fixture.write('app', 'wiring.ts', fixture.source(selectingLibrary("import { VendorBindModule } from '../../vendor-lib/src/index';")));
        expect(fixture.format().join('\n')).toMatch(/VendorBindModule is declared in .*VendorModules\.ts/);
        expect(() => fixture.extract()).toThrow(/Application selects VendorBindModule, which is declared in .*vendor-lib\/src\/VendorModules\.ts/);
    });

    it('rejects a ContainerModule selected as a bind module', () => {
        const fixture = new Fixture();
        fixture.write('vendor-lib', 'wiring.ts', fixture.source('export class VendorModule extends ContainerModule { constructor() { super(() => undefined); } }'));
        fixture.write('app', 'wiring.ts', fixture.source(`import { VendorModule } from '../../vendor-lib/src/wiring';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new VendorModule() as BindModule]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(fixture.format().join('\n')).toMatch(/Select a named framework binding instance/);
        expect(() => fixture.extract()).toThrow(/Wrong binding selection new VendorModule\(\) as BindModule/);
    });

    it('lets only an AppWiring select another owner\'s BindModule; a library Wiring cannot compose libraries', () => {
        const fixture = new Fixture();
        fixture.write('vendor-lib', 'wiring.ts', fixture.source(libraryModule));
        fixture.write('library', 'wiring.ts', fixture.source(`import { VendorBindModule } from '../../vendor-lib/src/wiring';
            export class Library implements Wiring {
                getBindModules(): BindModule[] { return [new VendorBindModule('x')]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(() => fixture.extract('library')).toThrow(/Library selects VendorBindModule, which is declared in .*vendor-lib\/src\/wiring\.ts\. Declare the BindModule class VendorBindModule, with its registrations, beside Library in .*library\/src\/wiring\.ts;/);
    });

    it('never lets a non-canonical module add relationships or be discovered as a fallback', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + app));
        fixture.write('app', 'RuntimeModules.ts', fixture.source(`
            export class HiddenClients implements BindModule {
                configure(binder: Binder): void { binder.createRpcClientAndBind(AuthApi, 'hidden'); }
            }
            export class HiddenWiring implements Wiring {
                getBindModules(): BindModule[] { return [new HiddenClients()]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        const declaration = fixture.extract();
        expect(Object.keys(declaration.exports).sort()).toEqual(['Application', 'Clients', 'Routes']);
        expect(JSON.stringify(declaration)).not.toContain('hidden');
        const assembled = new RuntimeWiringAssembler(new Map([['app', declaration]])).assemble('app');
        expect(assembled.map((relationship: ResolvedWiringRelationship) => `${relationship.direction}:${relationship.api}`))
            .toEqual(['uses:SaveApi', 'implements:AuthApi']);
    });

    it('rejects a library Wiring that is not declared in its owner\'s canonical wiring.ts, even through a re-export', () => {
        const fixture = new Fixture();
        fixture.write('library', 'wiring.ts', fixture.source(leaf));
        fixture.write('library', 'AuthWiring.ts', fixture.source(`import { Clients, Routes } from './wiring';
            export class AuthWiring implements Wiring {
                getBindModules(): BindModule[] { return [new Clients('auth')]; }
                getRouteModules(): RouteModule[] { return [new Routes()]; }
            }`));
        fixture.write('library', 'index.ts', "export { AuthWiring } from './AuthWiring';");
        fixture.write('app', 'wiring.ts', fixture.source(`import { AuthWiring } from '../../library/src/index';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return [new AuthWiring()]; }
                getBindModules(): BindModule[] { return []; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(() => fixture.extract()).toThrow(/library Wiring library#AuthWiring, which is declared in .*AuthWiring\.ts\. A library Wiring and its modules belong in that library's canonical .*library\/src\/wiring\.ts/);
    });

    it('rejects selection getters or configure inherited from a non-canonical base class', () => {
        const fixture = new Fixture();
        fixture.write('app', 'RuntimeModules.ts', fixture.source(`
            export class PreparedApplication {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return []; }
                getRouteModules(): RouteModule[] { return []; }
            }
            export class BaseClients { configure(binder: Binder): void { binder.createRpcClientAndBind(SaveApi, 'store'); } }`));
        fixture.write('app', 'wiring.ts', fixture.source(`import { PreparedApplication } from './RuntimeModules';
            export class Application extends PreparedApplication implements AppWiring {}`));
        expect(() => fixture.extract()).toThrow(/selection getter is declared in .*RuntimeModules\.ts/);
        const inherited = new Fixture();
        inherited.write('app', 'RuntimeModules.ts', fixture.source(
            "export class BaseClients { configure(binder: Binder): void { binder.createRpcClientAndBind(SaveApi, 'store'); } }"));
        inherited.write('app', 'wiring.ts', fixture.source(`import { BaseClients } from './RuntimeModules';
            export class Clients extends BaseClients implements BindModule {}
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients()]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(() => inherited.extract()).toThrow(/configure is inherited from .*RuntimeModules\.ts/);
    });

    it('still resolves re-exported API identities, bindExternal contracts and policies declared in wiring.ts', () => {
        const fixture = new Fixture();
        fixture.write('contracts', 'index.ts', "export { SaveApi as RenamedSaveApi } from './api';");
        fixture.write('vendor', 'api.ts', 'export abstract class VendorApi { abstract call(): void; }');
        fixture.write('vendor-client', 'client.ts', "import { VendorApi } from '../../vendor/src/api'; export class VendorClient extends VendorApi { call(): void {} }");
        fixture.write('app', 'Consumer.ts', "import { VendorApi } from '../../vendor/src/api'; export class Consumer { constructor(private readonly vendor: VendorApi) {} }");
        fixture.write('app', 'wiring.ts', fixture.source(`import { RenamedSaveApi as Save } from '../../contracts/src/index';
            import { VendorApi } from '../../vendor/src/api';
            import { VendorClient } from '../../vendor-client/src/client';
            export class Clients implements BindModule {
                constructor(private readonly policy: WiringPolicy) {}
                configure(binder: Binder): void {
                    binder.bindExternal(VendorApi, VendorClient);
                    if (this.policy.enabled) binder.createRpcClientAndBind(Save, 'store');
                }
            }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients(new WiringPolicy('clients', true))]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(fixture.format()).toEqual([]);
        const relationships = fixture.extract().exports.Clients.relationships;
        expect(relationships.map((relationship: WiringRelationship) => `${relationship.contract.project}#${relationship.contract.exportedName}:${relationship.transport}`))
            .toEqual(['vendor#VendorApi:external', 'contracts#SaveApi:rpc']);
        expect(relationships[0].target).toEqual({ kind: 'unknown', reason: 'Vendor interface; destination classified by approved contract metadata' });
        expect(relationships[1].policy).toBe('policy');
    });

    it('bindExternal in an app still requires a production business consumer of the contract', () => {
        const fixture = new Fixture();
        fixture.write('vendor', 'api.ts', 'export abstract class VendorApi { abstract call(): void; } export class VendorClient extends VendorApi { call(): void {} }');
        fixture.write('app', 'wiring.ts', fixture.source(`import { VendorApi, VendorClient } from '../../vendor/src/api';
            export class Clients implements BindModule { configure(binder: Binder): void { binder.bindExternal(VendorApi, VendorClient); } }
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new Clients()]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        expect(() => fixture.extract()).toThrow(/vendor#VendorApi has no production business consumer in app/);
    });

    it('lets a library BindModule bind its vendor adapter with bindExternal; the edge lands on the selecting app', () => {
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
        fixture.write('app', 'support.ts', 'export const prepared = { vendor: {} };');
        fixture.write('app', 'wiring.ts', fixture.source(`import { VendorBindModule } from '../../vendor/src/wiring';
            import { prepared } from './support';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindModules(): BindModule[] { return [new VendorBindModule(prepared.vendor)]; }
                getRouteModules(): RouteModule[] { return []; }
            }`));
        const assembled = new RuntimeWiringAssembler(new Map([['app', fixture.extract()], ['vendor', fixture.extract('vendor')]])).assemble('app');
        expect(assembled).toMatchObject([{ owner: 'vendor', api: 'VendorApi', direction: 'uses', transport: 'external' }]);
        expect(assembled[0].via).toContain('/bindModules[0]:vendor#VendorBindModule');
    });
});
