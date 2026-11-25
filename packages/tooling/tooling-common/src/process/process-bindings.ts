import { Container } from 'inversify';

import { GitProcessApi } from './git-process-api';
import { GitProcessClient } from './git-process-client';
import { NativeProcessApi } from './native-process-api';
import { NativeProcessClient } from './native-process-client';
import { ProcessEdgeClass, ProcessEdgeCopies } from './process-edge-copies';
import { TimerApi } from './timer-api';
import { TimerClient } from './timer-client';

/**
 * Binds the production edges — git, every other program, and the clock — into a program's container.
 * Every tooling entry point that builds a container calls this once; a feature test calls it too and then
 * REBINDS the edges to mocks, so the program it resolves is the production DAG with only the edges swapped.
 *
 * Explicit, because an `autobind` container would otherwise instantiate the ABSTRACT api class itself — which
 * now refuses at resolution (`ProcessEdgeCopies.refuseUnbound`) instead of failing on the first call.
 *
 * Every OTHER loaded copy of an edge class (a second `@webpieces/tooling-common` nested under another
 * package, #1437) is aliased to the one bound here with `toService`, so a consumer gets the same edge
 * whichever copy it imported — and a feature test's `rebind` of the edge reaches every copy.
 */
export class ProcessBindings {
    bind(container: Container): void {
        container.bind(GitProcessApi).to(GitProcessClient).inSingletonScope();
        container.bind(NativeProcessApi).to(NativeProcessClient).inSingletonScope();
        container.bind(TimerApi).to(TimerClient).inSingletonScope();
        this.aliasOtherCopies(container, GitProcessApi);
        this.aliasOtherCopies(container, NativeProcessApi);
        this.aliasOtherCopies(container, TimerApi);
    }

    private aliasOtherCopies(container: Container, edge: ProcessEdgeClass): void {
        for (const copy of ProcessEdgeCopies.otherCopiesOf(edge)) {
            container.bind(copy).toService(edge);
        }
    }
}
