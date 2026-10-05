import { describe, expect, it } from 'vitest';
import { Fixture } from './__tests__/wiring-fixture';
import { RuntimeWiringAssembler } from './assembler';
import { RuntimeDeclarationCodec } from './codec';

const leaf = `export class Clients implements BindingModule {
    constructor(private readonly destination: string) {}
    configure(options: object): void { new RuntimeClients().bindRpc(SaveApi, SaveApi, this.destination); }
}
export class Routes implements RouteModule {
    configure(router: WebpiecesRouter): void { router.addRoutes(AuthApi, AuthApi); }
}`;
const app = `export class Application implements AppWiring {
    getWirings(): Wiring[] { return []; }
    getBindingModules(): BindingModule[] { return [new Clients('store')]; }
    getRoutingModules(): RouteModule[] { return [new Routes()]; }
}`;

describe('typed Wiring/AppWiring extraction', () => {
    it('forwards a prepared destination and named policy through app, library and module', () => {
        const fixture = new Fixture();
        fixture.write('library', 'wiring.ts', fixture.source(`
            export class Clients implements BindingModule {
                constructor(private readonly destination: string, private readonly policy: WiringPolicy) {}
                configure(options: object): void {
                    if (this.policy.enabled) new RuntimeClients().bindRpc(SaveApi, SaveApi, this.destination);
                }
            }
            export class Library implements Wiring {
                constructor(private readonly config: { store: string }, private readonly selected: WiringPolicy) {}
                getBindingModules(): BindingModule[] { return [new Clients(this.config.store, this.selected)]; }
                getRoutingModules(): RouteModule[] { return []; }
            }`));
        fixture.write('app', 'config.ts', "export const prepared = { store: 'database' };");
        fixture.write('app', 'wiring.ts', fixture.source(`
            import { Library } from '../../library/src/wiring';
            import { prepared } from './config';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return [new Library(prepared, new WiringPolicy('public', true))]; }
                getBindingModules(): BindingModule[] { return []; }
                getRoutingModules(): RouteModule[] { return []; }
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
        expect(result.exports.Application.bindingModules[0].targets).toEqual({ destination: { kind: 'service', service: 'store' } });
        expect(result.exports.Application.routingModules[0].exportedName).toBe('Routes');
        expect(result.exports.Clients.relationships[0]).toMatchObject({ contract: { project: 'contracts', exportedName: 'SaveApi' }, target: { kind: 'parameter', parameter: 'destination' } });
        expect(new RuntimeDeclarationCodec().decode(JSON.stringify(result), 'app')).toEqual(result);
    });

    it('selects both lists from a library once, retaining repeats with independent destinations and ignoring unselected exports', () => {
        const fixture = new Fixture();
        fixture.write('library', 'wiring.ts', fixture.source(leaf + `
            export class AuthWiring implements Wiring {
                constructor(private readonly store: string) {}
                getBindingModules(): BindingModule[] { return [new Clients(this.store)]; }
                getRoutingModules(): RouteModule[] { return [new Routes()]; }
            }
            export class Unselected implements Wiring {
                getBindingModules(): BindingModule[] { return [new Clients('unused')]; }
                getRoutingModules(): RouteModule[] { return []; }
            }`));
        fixture.write('library', 'index.ts', "export { AuthWiring as Authentication } from './wiring';");
        fixture.write('app', 'wiring.ts', fixture.source(`import { Authentication as Auth } from '../../library/src/index';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return [new Auth('first'), new Auth('second')]; }
                getBindingModules(): BindingModule[] { return []; }
                getRoutingModules(): RouteModule[] { return []; }
            }`));
        const library = fixture.extract('library');
        expect(library.entry).toBeUndefined();
        expect(library.host).toBeUndefined();
        const result = new RuntimeWiringAssembler(new Map([['app', fixture.extract()], ['library', library]])).assemble('app');
        expect(result.map((relationship) => relationship.api)).toEqual(['SaveApi', 'SaveApi', 'AuthApi', 'AuthApi']);
        expect(result.slice(0, 2).map((relationship) => relationship.target)).toEqual([{ kind: 'service', service: 'first' }, { kind: 'service', service: 'second' }]);
        expect(result[0].via).toContain('library#AuthWiring');
        expect(result).toHaveLength(4);
    });

    it('never runs imported module constructors while extracting prepared config paths', () => {
        const fixture = new Fixture();
        fixture.write('app', 'Clients.ts', fixture.source(`export class Clients implements BindingModule {
            constructor(private readonly config: { auth: { store: string } }) { throw new Error('must never execute'); }
            configure(options: object): void { new RuntimeClients().bindRpc(SaveApi, SaveApi, this.config.auth.store); }
        }`));
        fixture.write('app', 'wiring.ts', fixture.source(`import { Clients } from './Clients';
            import { prepared } from './config';
            export class Application implements AppWiring {
                getWirings(): Wiring[] { return []; }
                getBindingModules(): BindingModule[] { return [new Clients(prepared)]; }
                getRoutingModules(): RouteModule[] { return []; }
            }`));
        fixture.write('app', 'config.ts', "export const prepared = { auth: { store: 'database', password: 'never-a-graph-target' } };");
        const result = fixture.extract();
        expect(result.exports.Application.bindingModules[0].targets).toEqual({ 'config.auth.store': { kind: 'service', service: 'database' } });
        expect(JSON.stringify(result)).not.toContain('never-a-graph-target');
    });

    it('rejects unrelated classes with topology method names without fabricating relationships', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + app));
        fixture.write('app', 'unrelated.ts', 'export class Unrelated { bindRpc(a: object, b: object, c: string) {} } new Unrelated().bindRpc({}, {}, "unrelated");');
        expect(Object.keys(fixture.extract().exports)).not.toContain('Unrelated');
    });

    it.each([
        app.replace("[new Clients('store')]", '[...modules]'),
        app.replace("[new Clients('store')]", '[new Routes()]'),
        app.replace('return [];', 'return [new Application()];'),
        app.replace("return [new Clients('store')];", "const modules = [new Clients('store')]; return modules;"),
        app + app.replace('Application', 'Other'),
    ])('rejects unsupported, wrong-kind and ambiguous topology', (source) => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(leaf + source));
        expect(() => fixture.extract()).toThrow();
    });
});
