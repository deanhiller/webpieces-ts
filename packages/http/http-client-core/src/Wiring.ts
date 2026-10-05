/** Platform adapters supply their own module types; topology stays transport independent. */
export interface Wiring<B, R> {
    getBindingModules(): B[];
    getRoutingModules(): R[];
}

/** Only applications select libraries. Libraries expose their own two module channels. */
export interface AppWiring<B, R> extends Wiring<B, R> {
    getWirings(): Wiring<B, R>[];
}

/** Ordered materialization preserves configured instances and repeated selections. */
export class WiringModules<B, R> {
    readonly bindingModules: B[];
    readonly routingModules: R[];

    constructor(app: AppWiring<B, R>) {
        this.bindingModules = [...app.getBindingModules()];
        this.routingModules = [...app.getRoutingModules()];
        const selected = new Map<Wiring<B, R>, WiringLists<B, R>>();
        for (const library of app.getWirings()) {
            let lists = selected.get(library);
            if (lists === undefined) {
                lists = new WiringLists(library.getBindingModules(), library.getRoutingModules());
                selected.set(library, lists);
            }
            this.bindingModules.push(...lists.bindings);
            this.routingModules.push(...lists.routes);
        }
    }
}

class WiringLists<B, R> {
    constructor(readonly bindings: B[], readonly routes: R[]) {}
}
