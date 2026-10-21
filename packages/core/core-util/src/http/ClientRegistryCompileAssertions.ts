import { ClientRegistry } from './ClientRegistry';
import { CallScope } from './CallScope';
import { CallContext } from './CallStrategy';
import { WRITE } from './HttpEndpointOptions';

/** An abstract SDK-wrapping `XxxApi` — the shape an api-client keys its policies by. */
abstract class AbstractTargetApi {
    abstract work(): Promise<void>;
}

/** A concrete `@ApiPath`-style contract class. */
class ConcreteTargetApi {
    work(): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * Compiled by tsc (spec files are not), never executed. Pins the ONE spelling of a call scope —
 * `CallScope.all()` / `.api(X)` / `.method(X, 'm')` — and that the per-call timeout and strategy
 * live on `ClientRegistry`. tsc fails the build with TS2578 if any of these ever starts compiling.
 */
class ClientRegistryCompileAssertions {
    scopeIsACallScope(): void {
        // @ts-expect-error the 'ALL' string became CallScope.all()
        ClientRegistry.setTimeout(100, 'ALL');
        // @ts-expect-error a string is never a scope — use CallScope.all() / .api(X) / .method(X, 'm')
        ClientRegistry.setStrategy(undefined, 'random');
        // @ts-expect-error the (Api, 'method') tuple became CallScope.method(Api, 'method')
        ClientRegistry.setTimeout(100, ConcreteTargetApi, 'work');
        // @ts-expect-error a bare class became CallScope.api(Api)
        ClientRegistry.setTimeout(100, ConcreteTargetApi);
        // @ts-expect-error an object literal is not a scope — the factories are the only way to get one
        ClientRegistry.setTimeout(100, {});
        // @ts-expect-error an object literal shaped like a scope is not one either (CallScope is nominal)
        ClientRegistry.setTimeout(100, { api: ConcreteTargetApi, methodName: 'work' });
        // @ts-expect-error the constructor is private — use CallScope.all() / .api(X) / .method(X, 'm')
        void new CallScope(undefined, undefined);
    }

    methodNameIsChecked(): void {
        ClientRegistry.setTimeout(100, CallScope.method(ConcreteTargetApi, 'work'));
        ClientRegistry.setTimeout(100, CallScope.method(AbstractTargetApi, 'work'));
        // @ts-expect-error a misspelled method does not compile — it would silently match nothing
        ClientRegistry.setTimeout(100, CallScope.method(ConcreteTargetApi, 'wrok'));
        // @ts-expect-error a misspelled method does not compile on an abstract XxxApi either
        ClientRegistry.setStrategy(undefined, CallScope.method(AbstractTargetApi, 'wrok'));
    }

    callRegistryIsDeleted(): void {
        // @ts-expect-error CallRegistry is deleted: CallRegistry.setTimeout became ClientRegistry.setTimeout
        CallRegistry.setTimeout(100, CallScope.all());
    }

    /** A CallContext's contract is the CLASS, never undefined (#1350). */
    contractIsNeverUndefined(): void {
        // @ts-expect-error CallContext's contract is a CLASS, never undefined — pass the real contract class
        void new CallContext('Api', 'work', WRITE, undefined);
    }

    /** The transport fallback is a TransportDefault (timeout + optional strategy), never a bare number. */
    fallbackIsATransportDefault(): void {
        const context = new CallContext('Api', 'work', WRITE, ClientRegistryCompileAssertions);
        void ClientRegistry.execute(
            ClientRegistryCompileAssertions,
            context,
            (ms: number) => Promise.resolve(ms),
            // @ts-expect-error execute(..., defaultMs: number) became execute(..., fallback: TransportDefault)
            30_000,
        );
    }
}
