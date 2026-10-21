import { CallRegistry } from './CallRegistry';
import { CallContext } from './CallStrategy';
import { WRITE } from './HttpEndpointOptions';

/** Compiled by tsc (spec files are not), never executed. */
class CallRegistryCompileAssertions {
    check(): void {
        // @ts-expect-error ALL cannot select a method
        CallRegistry.setTimeout(100, 'ALL', 'work');
        // @ts-expect-error ALL cannot select a method
        CallRegistry.setStrategy(undefined, 'ALL', 'work');
    }

    /** A CallContext's contract is the CLASS, never undefined (#1350). */
    contractIsNeverUndefined(): void {
        // @ts-expect-error CallContext's contract is a CLASS, never undefined — pass the real contract class
        void new CallContext('Api', 'work', WRITE, undefined);
    }

    /** The transport fallback is a TransportDefault (timeout + optional strategy), never a bare number. */
    fallbackIsATransportDefault(): void {
        const context = new CallContext('Api', 'work', WRITE, CallRegistryCompileAssertions);
        void CallRegistry.execute(
            CallRegistryCompileAssertions,
            context,
            (ms: number) => Promise.resolve(ms),
            // @ts-expect-error execute(..., defaultMs: number) became execute(..., fallback: TransportDefault)
            30_000,
        );
    }
}
