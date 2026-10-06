import { BrowserClassProvider, BrowserExistingProvider } from './BrowserProviders';
import type { BrowserProvider, BrowserToken } from './BrowserProviders';

/** A class the injector may construct (`useClass`). */
export type ExternalClassType<T extends object> = new (...args: never[]) => T;
/** A class token the injector already provides (`useExisting`), possibly abstract. */
export type ExternalExistingType<T extends object> = abstract new (...args: never[]) => T;

/**
 * The vendor implementation handed to {@link Binder.bindExternal}. A class the injector constructs
 * and a class it already provides are both classes at runtime, so the recipe is NAMED by the class
 * that carries it rather than guessed from the argument:
 *
 * - `new UseClass(Vendor)` — the external contract is constructed as `Vendor`.
 * - `new UseExisting(Logged)` — the external contract aliases the token `Logged`, which is provided
 *   elsewhere (e.g. `@Injectable({ providedIn: 'root' })`), so both tokens share one instance.
 *
 * `T` is what the implementation provides; bindExternal requires it to satisfy the contract.
 */
export abstract class ExternalImpl<T extends object> {
    /** Type-only: carries `T` so an implementation of the wrong contract does not compile. */
    declare readonly implementation: T;

    /** The structural provider registering `contract` with this implementation. */
    abstract provider(contract: BrowserToken): BrowserProvider;
}

/** `useClass`: the external contract is constructed as {@link useClass}. */
export class UseClass<T extends object> extends ExternalImpl<T> {
    constructor(public readonly useClass: ExternalClassType<T>) {
        super();
    }

    provider(contract: BrowserToken): BrowserProvider {
        return new BrowserClassProvider(contract, this.useClass);
    }
}

/** `useExisting`: the external contract aliases the already-provided token {@link useExisting}. */
export class UseExisting<T extends object> extends ExternalImpl<T> {
    constructor(public readonly useExisting: ExternalExistingType<T>) {
        super();
    }

    provider(contract: BrowserToken): BrowserProvider {
        return new BrowserExistingProvider(contract, this.useExisting);
    }
}
