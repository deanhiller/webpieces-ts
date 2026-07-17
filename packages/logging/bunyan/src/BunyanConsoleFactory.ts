import { BunyanFactoryBase } from './BunyanFactoryBase';
import { createConsoleStream } from './streams';

/**
 * BunyanConsoleFactory - the LOCAL developer backend. Human-readable, greppable
 * text to stdout (`[LEVEL][time][ctx tags]: message`) with the registered context
 * keys as tags — same enrichment as the GCP backend, different rendering. Mirrors
 * the tested trytami local console stream.
 *
 * The service name comes from {@link ServiceInfo}, which startup must have named
 * BEFORE constructing this.
 */
export class BunyanConsoleFactory extends BunyanFactoryBase {
    constructor() {
        super([createConsoleStream()]);
    }
}
