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

    /** The transport fallback is a TransportDefault (timeout + optional strategy), never a bare number. */
    fallbackIsATransportDefault(): void {
        const context = new CallContext('Api', 'work', WRITE);
        void CallRegistry.execute(
            CallRegistryCompileAssertions,
            context,
            (ms: number) => Promise.resolve(ms),
            // @ts-expect-error execute(..., defaultMs: number) became execute(..., fallback: TransportDefault)
            30_000,
        );
    }
}
