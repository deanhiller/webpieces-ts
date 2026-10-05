import { describe, expect, it } from 'vitest';
import { Fixture } from './__tests__/wiring-fixture';
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

    it('checks the agreed 200-line bound while exempting non-wiring implementations', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source(valid + '\n'.repeat(220) + '// too long'));
        fixture.write('app', 'implementation.ts', 'export function arbitrary() { return new ContainerModule(() => {}); }');
        expect(fixture.format().join('\n')).toContain('exceeds 200 lines');
        const program = fixture.program();
        const other = program.getSourceFiles().find((file) => file.fileName.endsWith('implementation.ts'))!;
        expect(new WiringFormat(program.getTypeChecker(), 200).problems(other)).toEqual([]);
    });

    it('reports unchanged canonical violations from every participating owner in one failure', () => {
        const fixture = new Fixture();
        fixture.write('app', 'wiring.ts', fixture.source('export function hidden() {}'));
        fixture.write('library', 'wiring.ts', fixture.source('export const hidden = [];'));
        expect(() => new WorkspaceWiringFormat().assert(fixture.root, fixture.infos, 200)).toThrow(/app.*wiring.ts.*\n.*library.*wiring.ts/s);
    });
});
