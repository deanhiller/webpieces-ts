import { Container } from 'inversify';
import { ProcessBindings } from '@webpieces/tooling-common';

/**
 * THE container every `wp-*` bin resolves its program from — and the one a feature test builds too,
 * before rebinding the process edges to mocks. One factory, so a test cannot assemble a DAG the shipped
 * bin does not.
 */
export class PrGateContainer {
    create(): Container {
        const container = new Container({ autobind: true });
        new ProcessBindings().bind(container);
        return container;
    }
}
