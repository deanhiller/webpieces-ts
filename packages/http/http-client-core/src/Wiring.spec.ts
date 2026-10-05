import { describe, expect, it } from 'vitest';
import { AppWiring, Wiring, WiringModules } from './Wiring';
class Module { constructor(readonly name: string) {} }
class Library implements Wiring<Module, Module> {
    bindingCalls = 0;
    routeCalls = 0;
    readonly binding: Module;
    readonly route: Module;
    constructor(name: string) {
        this.binding = new Module(`${name}-bindings`);
        this.route = new Module(`${name}-routes`);
    }
    getBindingModules(): Module[] { this.bindingCalls++; return [this.binding]; }
    getRoutingModules(): Module[] { this.routeCalls++; return [this.route]; }
}
class Application extends Library implements AppWiring<Module, Module> {
    childCalls = 0;
    constructor(readonly children: Library[]) { super('app'); }
    getWirings(): Library[] { this.childCalls++; return this.children; }
}
describe('one-level runtime materialization', () => {
    it('materializes both channels once per selection, preserving local-first order and identity', () => {
        const first = new Library('first');
        const second = new Library('second');
        const app = new Application([first, second]);
        const modules = new WiringModules(app);
        expect(modules.bindingModules).toEqual([app.binding, first.binding, second.binding]);
        expect(modules.routingModules).toEqual([app.route, first.route, second.route]);
        expect(modules.bindingModules[1]).toBe(first.binding);
        expect(modules.routingModules[1]).toBe(first.route);
        expect([app, first, second].map((wiring: Library) => [wiring.bindingCalls, wiring.routeCalls])).toEqual([[1, 1], [1, 1], [1, 1]]);
        expect(app.childCalls).toBe(1);
    });
    it('retains repeated selections instead of silently deduplicating', () => {
        const library = new Library('repeat');
        const modules = new WiringModules(new Application([library, library]));
        expect(modules.bindingModules.slice(1)).toEqual([library.binding, library.binding]);
        expect(modules.routingModules.slice(1)).toEqual([library.route, library.route]);
        expect(library.bindingCalls).toBe(1);
    });
});
