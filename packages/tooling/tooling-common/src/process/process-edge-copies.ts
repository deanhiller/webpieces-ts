import { InformAiError } from '../inform-ai-error';

/** The class object of an abstract process edge (`GitProcessApi`, `NativeProcessApi`, `TimerApi`). */
export type ProcessEdgeClass = abstract new (...args: never[]) => object;

declare global {
    // A process-wide registry has to live on the global object: it is the one thing every loaded copy of
    // this package shares. Declared with `var` because that is the only form `globalThis` types.
    // eslint-disable-next-line no-var
    var webpiecesProcessEdgeCopies: Map<string, ProcessEdgeClass[]> | undefined;
}

/**
 * Every loaded COPY of each process edge class, process-wide (#1437).
 *
 * A package manager may install more than one copy of `@webpieces/tooling-common` — this repo's own
 * hoisted install nests one inside every dependent — and each copy defines its own `GitProcessApi` class
 * object. inversify keys a binding by that object, so a consumer compiled against copy B asks the
 * container for B's class while {@link ProcessBindings} (running from copy A) bound only A's. An `autobind`
 * container then instantiates B's ABSTRACT class, whose `run` does not exist.
 *
 * So every edge class registers itself here when its module loads, and `ProcessBindings` aliases each
 * other copy to the one it binds — one edge, whichever copy a consumer imported it from.
 */
export class ProcessEdgeCopies {
    /** Called once per edge class, at its module's load. */
    static register(edge: ProcessEdgeClass): void {
        const registry = ProcessEdgeCopies.registry();
        const copies = registry.get(edge.name) ?? [];
        copies.push(edge);
        registry.set(edge.name, copies);
    }

    /** Every loaded copy of `edge` OTHER than `edge` itself. Empty when exactly one copy is installed. */
    static otherCopiesOf(edge: ProcessEdgeClass): ProcessEdgeClass[] {
        const copies = ProcessEdgeCopies.registry().get(edge.name) ?? [];
        return copies.filter((copy: ProcessEdgeClass): boolean => copy !== edge);
    }

    /**
     * Called from each edge's constructor. Constructing the abstract edge class ITSELF (not a subclass)
     * only ever happens when an `autobind` container found no binding for that copy — so fail at resolution,
     * naming what is missing, rather than hand back an object whose every method is undefined.
     */
    static refuseUnbound(constructed: ProcessEdgeClass, edge: ProcessEdgeClass): void {
        if (constructed !== edge) return;
        throw new InformAiError(
            `${edge.name} was resolved with no binding, so the container constructed the abstract process edge itself. ` +
                `The container never ran \`new ProcessBindings().bind(container)\`, or this copy of @webpieces/tooling-common ` +
                `was loaded only after it ran. Bind the process edges once every module that injects them is loaded.`,
        );
    }

    private static registry(): Map<string, ProcessEdgeClass[]> {
        globalThis.webpiecesProcessEdgeCopies ??= new Map<string, ProcessEdgeClass[]>();
        return globalThis.webpiecesProcessEdgeCopies;
    }
}
