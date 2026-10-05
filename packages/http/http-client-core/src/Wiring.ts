/**
 * One named DI module, for every host. The host hands it the ONE binder it understands: Node's binder
 * wraps an Inversify load, the browser's collects Angular provider recipes. Each host re-exports a
 * non-generic alias, so app code still writes `implements BindModule`.
 */
export interface BindModule<B> {
    configure(binder: B): void | Promise<void>;
}

/** A library's selectable modules. Hosts with routes (Node) add their route channel on top. */
export interface Wiring<M> {
    getBindModules(): M[];
}

/** Only applications select libraries. */
export interface AppWiring<M, W extends Wiring<M> = Wiring<M>> extends Wiring<M> {
    getWirings(): W[];
}

/**
 * The app first, then each selected library in order. A repeated selection is retained (its lists
 * appear again) but each wiring instance's getters run exactly once.
 */
export class WiringOrder<W> {
    readonly ordered: W[];

    constructor(app: W, libraries: readonly W[]) {
        this.ordered = [app, ...libraries];
    }

    collect<T>(read: (wiring: W) => T[]): T[] {
        const cache = new Map<W, T[]>();
        const result: T[] = [];
        for (const wiring of this.ordered) {
            let list = cache.get(wiring);
            if (list === undefined) {
                list = [...read(wiring)];
                cache.set(wiring, list);
            }
            result.push(...list);
        }
        return result;
    }
}

/** Ordered materialization of the bind channel; preserves configured instances and repeated selections. */
export class WiringModules<M> {
    readonly bindModules: M[];

    constructor(app: AppWiring<M>) {
        this.bindModules = new WiringOrder<Wiring<M>>(app, app.getWirings()).collect(
            (wiring: Wiring<M>) => wiring.getBindModules(),
        );
    }
}
