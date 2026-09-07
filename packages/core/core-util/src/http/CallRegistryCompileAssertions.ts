import { CallRegistry } from './CallRegistry';

/** Compiled by tsc (spec files are not), never executed. */
class CallRegistryCompileAssertions {
    check(): void {
        // @ts-expect-error ALL cannot select a method
        CallRegistry.setTimeout(100, 'ALL', 'work');
        // @ts-expect-error ALL cannot select a method
        CallRegistry.setStrategy(undefined, 'ALL', 'work');
    }
}
