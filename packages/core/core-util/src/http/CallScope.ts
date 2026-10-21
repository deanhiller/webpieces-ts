/**
 * Where a policy applies: every contract (`'ALL'`, which has no method), one contract, or one method
 * of one contract. The contract is always the CLASS (the `@ApiPath` contract, or an SDK-wrapping
 * api-client's abstract `XxxApi`), never its name — a string key is one typo away from silently
 * matching nothing.
 *
 * Every per-call startup registry scopes its settings with this ONE ladder: `CallRegistry`
 * (strategy, timeout), `ClientRegistry` (error translator, error classifier) and cloudtasks-client's
 * `GcpTaskRegistry` (customizer, gax). Resolution is always method -> API -> ALL -> the registry's
 * own webpieces default.
 */
export type CallScope = [api: 'ALL'] | [api: Function, methodName?: string];

class ApiRungs<T> {
    api?: T;
    readonly methods = new Map<string, T>();
}

/**
 * The ONE implementation of the {@link CallScope} ladder. It stores one slot per scope (created on
 * first use by `create`) and answers a call's rungs most-specific-first; each registry decides what a
 * rung's slot holds and how a rung "answers" (first value present, or first verdict that does not
 * defer).
 */
export class CallScopeLadder<T> {
    private all: T | undefined;
    private readonly apis = new Map<Function, ApiRungs<T>>();

    constructor(private readonly create: () => T) {}

    /** The slot for `scope`, created on first use. Registries write their setting into it. */
    at(...scope: CallScope): T {
        const api = scope[0];
        if (api === 'ALL') {
            if (this.all === undefined) this.all = this.create();
            return this.all;
        }
        let rungs = this.apis.get(api);
        if (!rungs) {
            rungs = new ApiRungs<T>();
            this.apis.set(api, rungs);
        }
        const methodName = scope[1];
        if (methodName === undefined) {
            if (rungs.api === undefined) rungs.api = this.create();
            return rungs.api;
        }
        let slot = rungs.methods.get(methodName);
        if (slot === undefined) {
            slot = this.create();
            rungs.methods.set(methodName, slot);
        }
        return slot;
    }

    /**
     * The registered slots for one call, most specific first: method, then API, then ALL. A rung with
     * no slot is skipped. `api` undefined (a call with no contract class — an IPC hop, an MCP protocol
     * step, a failure before routing) reaches only the ALL rung.
     */
    rungs(api: Function | undefined, methodName: string | undefined): T[] {
        const found: T[] = [];
        const rungs = api === undefined ? undefined : this.apis.get(api);
        const method = methodName === undefined ? undefined : rungs?.methods.get(methodName);
        if (method !== undefined) found.push(method);
        if (rungs?.api !== undefined) found.push(rungs.api);
        if (this.all !== undefined) found.push(this.all);
        return found;
    }

    clear(): void {
        this.all = undefined;
        this.apis.clear();
    }
}
