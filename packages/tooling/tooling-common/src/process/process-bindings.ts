import { Container } from 'inversify';

import { GitProcessApi } from './git-process-api';
import { GitProcessClient } from './git-process-client';
import { NativeProcessApi } from './native-process-api';
import { NativeProcessClient } from './native-process-client';
import { TimerApi } from './timer-api';
import { TimerClient } from './timer-client';

/**
 * Binds the production edges — git, every other program, and the clock — into a program's container.
 * Every tooling entry point that builds a container calls this once; a feature test calls it too and then
 * REBINDS the edges to mocks, so the program it resolves is the production DAG with only the edges swapped.
 *
 * Explicit, because an `autobind` container would otherwise instantiate the ABSTRACT api class itself and
 * fail on the first call rather than at resolution.
 */
export class ProcessBindings {
    bind(container: Container): void {
        container.bind(GitProcessApi).to(GitProcessClient).inSingletonScope();
        container.bind(NativeProcessApi).to(NativeProcessClient).inSingletonScope();
        container.bind(TimerApi).to(TimerClient).inSingletonScope();
    }
}
