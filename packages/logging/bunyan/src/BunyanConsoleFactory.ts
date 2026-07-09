import { BunyanFactoryBase } from './BunyanFactoryBase';
import { BunyanFactoryOptions } from './BunyanFactoryOptions';
import { createConsoleStream } from './streams';

/**
 * BunyanConsoleFactory - the LOCAL developer backend. Human-readable, greppable
 * text to stdout (`[LEVEL][time][ctx tags]: message`) with the registered context
 * keys as tags — same enrichment as the GCP backend, different rendering. Mirrors
 * the tested trytami local console stream.
 */
export class BunyanConsoleFactory extends BunyanFactoryBase {
    constructor(opts: BunyanFactoryOptions) {
        super(opts.serviceName, [createConsoleStream()]);
    }
}
