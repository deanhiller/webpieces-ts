/**
 * Where a policy applies: every contract ({@link CallScope.all}), one contract ({@link CallScope.api}),
 * or one method of one contract ({@link CallScope.method}). The contract is always the CLASS (the
 * `@ApiPath` contract, or an SDK-wrapping api-client's abstract `XxxApi`), never its name — a string
 * key is one typo away from silently matching nothing — and `method` checks the method name against
 * that class, so a misspelled method does not compile either.
 *
 * The constructor is private: the three factories are the ONLY way to get one, so a string, `{}` or a
 * bare class is not a scope. `grep -rn 'CallScope.all('` lists every app-wide policy.
 *
 * ```ts
 * ClientRegistry.setTimeout(5_000, CallScope.api(VendorApi));
 * ClientRegistry.setStrategy(retry, CallScope.method(VendorApi, 'sync'));
 * ApiRegistry.setErrorTranslator(new AppErrorTranslator(), CallScope.all());
 * ```
 *
 * Every per-call startup registry scopes its settings with this ONE ladder: `ClientRegistry`
 * (strategy, timeout), `ApiRegistry` (error translator, error classifier) and cloudtasks-client's
 * `GcpTaskRegistry` (customizer, gax). Resolution is always method -> API -> ALL -> the registry's
 * own webpieces default.
 */
export class CallScope {
    /**
     * A private member makes the type NOMINAL: without it an object literal `{ api, methodName }`
     * would satisfy `CallScope` structurally and skip the factories.
     */
    private readonly nominal = true;

    private constructor(
        /** The contract CLASS, or `undefined` for every contract. */
        readonly api: Function | undefined,
        /** One method of {@link CallScope.api}, or `undefined` for the whole contract. */
        readonly methodName: string | undefined,
    ) {}

    /** Every contract — the app's (or company's) one policy. Has no method. */
    // webpieces-disable no-function-outside-class -- static factory of the scope value class
    static all(): CallScope {
        return new CallScope(undefined, undefined);
    }

    /** One contract, keyed by its CLASS. */
    // webpieces-disable no-function-outside-class -- static factory of the scope value class
    static api(api: Function): CallScope {
        return new CallScope(api, undefined);
    }

    /** One method of one contract; `methodName` must be a member the contract declares. */
    // webpieces-disable no-function-outside-class -- static factory of the scope value class
    static method<T>(api: abstract new (...args: never[]) => T, methodName: keyof T & string): CallScope {
        return new CallScope(api, methodName);
    }
}

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
    at(scope: CallScope): T {
        const api = scope.api;
        if (api === undefined) {
            if (this.all === undefined) this.all = this.create();
            return this.all;
        }
        let rungs = this.apis.get(api);
        if (!rungs) {
            rungs = new ApiRungs<T>();
            this.apis.set(api, rungs);
        }
        const methodName = scope.methodName;
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
     * no slot is skipped. `api` undefined (a failure before routing, which has no route and so no
     * contract class) reaches only the ALL rung.
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
