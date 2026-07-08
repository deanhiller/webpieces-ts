import type { ContextReader } from '@webpieces/core-util';
import { BunyanFactoryBase } from './BunyanFactoryBase';
import { BunyanFactoryOptions } from './BunyanFactoryOptions';
import { createConsoleStream } from './streams';

/**
 * BunyanConsoleFactory - the LOCAL developer backend. Human-readable, greppable
 * text to stdout (`[LEVEL][time][ctx tags]: message`) with the registered context
 * keys as tags — same enrichment as the GCP backend, different rendering. Mirrors
 * the tested trytami local console stream.
 *
 * @param reader the environment's ContextReader (on a node server, a
 *   `RequestContextReader` from @webpieces/core-context).
 */
export class BunyanConsoleFactory extends BunyanFactoryBase {
    constructor(reader: ContextReader, opts: BunyanFactoryOptions = new BunyanFactoryOptions()) {
        super(reader, opts.serviceName, [createConsoleStream(opts.level)]);
    }
}
