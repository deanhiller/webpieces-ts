import { describe, expect, it } from 'vitest';
import { AppWiring, Wiring, WiringModules, WiringOrder } from './Wiring';
class Module { constructor(readonly name: string) {} }
class Library implements Wiring<Module> {
    bindCalls = 0;
    readonly module: Module;
    constructor(name: string) {
        this.module = new Module(`${name}-bindings`);
    }
    getBindModules(): Module[] { this.bindCalls++; return [this.module]; }
}
class Application extends Library implements AppWiring<Module> {
    childCalls = 0;
    constructor(readonly children: Library[]) { super('app'); }
    getWirings(): Library[] { this.childCalls++; return this.children; }
}
describe('one-level runtime materialization', () => {
    it('materializes the bind channel once per selection, preserving local-first order and identity', () => {
        const first = new Library('first');
        const second = new Library('second');
        const app = new Application([first, second]);
        const modules = new WiringModules(app);
        expect(modules.bindModules).toEqual([app.module, first.module, second.module]);
        expect(modules.bindModules[1]).toBe(first.module);
        expect([app, first, second].map((wiring: Library) => wiring.bindCalls)).toEqual([1, 1, 1]);
        expect(app.childCalls).toBe(1);
    });
    it('retains repeated selections instead of silently deduplicating', () => {
        const library = new Library('repeat');
        const modules = new WiringModules(new Application([library, library]));
        expect(modules.bindModules.slice(1)).toEqual([library.module, library.module]);
        expect(library.bindCalls).toBe(1);
    });
    it('lets a host read a further channel from the same order, once per wiring instance', () => {
        const library = new Library('repeat');
        const app = new Application([library, library]);
        const order = new WiringOrder<Library>(app, app.getWirings());
        expect(order.collect((wiring: Library) => [wiring.module.name])).toEqual(['app-bindings', 'repeat-bindings', 'repeat-bindings']);
    });
});
