import { ProcessExitApi } from '@webpieces/tooling-common';

/**
 * What `MockProcessExitApi.exit` throws to stop the run exactly where the real exit would end the process
 * — so nothing the program would never have run after exiting runs in the test either.
 */
export class MockProcessExited extends Error {
    constructor(readonly code: number) {
        super(`the program asked to end with exit code ${String(code)}`);
        this.name = 'MockProcessExited';
    }
}

/**
 * The feature-test {@link ProcessExitApi}: records each requested exit code and stops the run by throwing
 * {@link MockProcessExited}. A test runs a bin's top level (`runMain`) in process and asserts on
 * {@link codes}, stdout and stderr — no node child is started to observe an exit status.
 */
export class MockProcessExitApi extends ProcessExitApi {
    readonly codes: number[] = [];

    override exit(code: number): never {
        this.codes.push(code);
        throw new MockProcessExited(code);
    }
}
