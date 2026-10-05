import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import { Fixture } from './di-graph-testkit';
import { createProjectProgram } from '../di-graph/program';
import { collectAngularProviders } from '../di-graph/angular-providers';

const fixtures: Fixture[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.cleanup()));

describe('named browser provider recipes', () => {
    it('retains factory dependencies, class implementations, constants and aliases', () => {
        const fixture = new Fixture({
            'packages/http/http-client-browser/BrowserProviders.ts': `
                export class BrowserValueProvider { constructor(provide: object, useValue: object) {} }
                export class BrowserFactoryProvider { constructor(provide: object, useFactory: object, deps: object[]) {} }
                export class BrowserClassProvider { constructor(provide: object, useClass: object) {} }
                export class BrowserExistingProvider { constructor(provide: object, useExisting: object) {} }`,
            'tokens.ts': 'export class Environment {} export class Config {} export class Service {} export class Implementation {} export class Alias {}',
            'bindings.ts': `import { BrowserValueProvider, BrowserFactoryProvider as Factory, BrowserClassProvider, BrowserExistingProvider } from './packages/http/http-client-browser/BrowserProviders';
                import { Environment, Config, Service, Implementation, Alias } from './tokens';
                new BrowserValueProvider(Environment, {});
                new Factory(Config, (env: Environment) => new Config(), [Environment]);
                new BrowserClassProvider(Service, Implementation);
                new BrowserExistingProvider(Alias, Service);`,
        });
        fixtures.push(fixture);
        const program = createProjectProgram(path.join(fixture.workspaceRoot, fixture.projectRoot))!;
        const table = collectAngularProviders(program, program.getTypeChecker(), fixture.workspaceRoot);
        const config = table.lookup('class:proj/src/tokens.ts#Config');
        expect(config).toHaveLength(1);
        expect(config[0]).toMatchObject({ kind: 'toDynamicValue', scope: 'singleton', factoryDeps: [{ key: 'class:proj/src/tokens.ts#Environment' }] });
        expect(table.lookup('class:proj/src/tokens.ts#Environment')[0]).toMatchObject({ kind: 'toConstantValue' });
        expect(table.lookup('class:proj/src/tokens.ts#Service')[0].implClass?.name?.text).toBe('Implementation');
        expect(table.lookup('class:proj/src/tokens.ts#Alias')[0].implClass?.name?.text).toBe('Service');
    });
});
