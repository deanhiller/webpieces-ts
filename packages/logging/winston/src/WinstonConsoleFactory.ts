import { format } from 'winston';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { bigIntSafeFormat, injectContextFormat, localPrettyFormat, severityFormat } from './format';

/**
 * WinstonConsoleFactory - the LOCAL developer backend. Colorized single-line
 * pretty console output with the registered context keys as a bracketed prefix,
 * for human reading — same enrichment as the GCP backend, different rendering.
 * Matches the tested onetablet/monorepo-nx1 local logger.
 *
 * The service name + version come from {@link ServiceInfo} (this constructor reads them), but
 * neither RENDERS locally: you already know which service you are running and can check git
 * yourself, so they would be noise on every line. They still ship to GCP via the sibling
 * {@link WinstonGcpFactory}. See LOCAL_STRUCTURAL_KEYS in ./format.
 */
export class WinstonConsoleFactory extends WinstonFactoryBase {
    constructor() {
        super(
            format.combine(
                bigIntSafeFormat(),
                injectContextFormat(),
                severityFormat(),
                format.colorize(),
                localPrettyFormat(),
            ),
        );
    }
}
