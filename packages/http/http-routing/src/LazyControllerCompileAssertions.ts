import type { WebpiecesRouter } from './WebpiecesRouter';
import type { LazyController, LazyImplementation } from './LazyController';

abstract class StringApi {
    abstract read(): Promise<string>;
}
abstract class NumberApi {
    abstract read(): Promise<number>;
}

/** Compiled by tsc, never invoked: implementation types must agree with the registered API. */
export class LazyControllerCompileAssertions {
    routes(
        router: WebpiecesRouter,
        strings: LazyController<StringApi>,
        numbers: LazyController<NumberApi>,
    ): void {
        router.addRoutes(StringApi, strings);
        // @ts-expect-error The deferred controller must implement this contract's result type.
        router.addRoutes(StringApi, numbers);
    }
    implementation(
        strings: LazyImplementation<StringApi>,
        numbers: LazyImplementation<NumberApi>,
    ): void {
        // @ts-expect-error A number-result implementation cannot be a string-result implementation.
        const invalid: LazyImplementation<StringApi> = numbers;
        void invalid;
        void strings;
    }
}
