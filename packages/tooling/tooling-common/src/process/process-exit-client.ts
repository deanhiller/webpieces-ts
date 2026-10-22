import { bindingScopeValues, injectable } from 'inversify';

import { ProcessExitApi } from './process-exit-api';

/** The production {@link ProcessExitApi}: node's own `process.exit`. */
@injectable(bindingScopeValues.Singleton)
export class ProcessExitClient extends ProcessExitApi {
    override exit(code: number): never {
        // webpieces-disable no-process-exit-outside-main -- THE exit edge itself; runMain is its only caller
        process.exit(code);
    }
}
