import { format } from 'winston';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { WinstonFactoryOptions } from './WinstonFactoryOptions';
import { bigIntSafeFormat, injectContextFormat, localPrettyFormat, severityFormat } from './format';

/**
 * WinstonConsoleFactory - the LOCAL developer backend. Colorized single-line
 * pretty console output with the registered context keys as a bracketed prefix,
 * for human reading — same enrichment as the GCP backend, different rendering.
 * Matches the tested onetablet/monorepo-nx1 local logger.
 */
export class WinstonConsoleFactory extends WinstonFactoryBase {
    constructor(opts: WinstonFactoryOptions = new WinstonFactoryOptions()) {
        super(
            format.combine(
                bigIntSafeFormat(),
                injectContextFormat(),
                severityFormat(),
                format.colorize(),
                localPrettyFormat(),
            ),
            opts,
        );
    }
}
