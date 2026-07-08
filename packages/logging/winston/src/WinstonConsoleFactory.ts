import { format } from 'winston';
import type { ContextReader } from '@webpieces/core-util';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { WinstonFactoryOptions } from './WinstonFactoryOptions';
import { bigIntSafeFormat, injectContextFormat, localPrettyFormat, severityFormat } from './format';

/**
 * WinstonConsoleFactory - the LOCAL developer backend. Colorized single-line
 * pretty console output with the registered context keys as a bracketed prefix,
 * for human reading — same enrichment as the GCP backend, different rendering.
 * Matches the tested onetablet/monorepo-nx1 local logger.
 *
 * @param reader the environment's ContextReader (on a node server, a
 *   `RequestContextReader` from @webpieces/core-context).
 */
export class WinstonConsoleFactory extends WinstonFactoryBase {
    constructor(reader: ContextReader, opts: WinstonFactoryOptions = new WinstonFactoryOptions()) {
        super(
            format.combine(
                bigIntSafeFormat(),
                injectContextFormat(reader),
                severityFormat(),
                format.colorize(),
                localPrettyFormat(),
            ),
            opts,
        );
    }
}
