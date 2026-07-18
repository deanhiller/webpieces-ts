import { format } from 'winston';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { bigIntSafeFormat, injectContextFormat, localPrettyFormat, severityFormat } from './format';

/**
 * WinstonConsoleFactory - the LOCAL developer backend. Single-line, greppable pretty console output
 * `[LEVEL][time][Controller.method][loggerName][ctx tags]: message` — same enrichment as the GCP
 * backend, different rendering, byte-identical to the bunyan console backend for the same record.
 *
 * PLAIN TEXT (no `format.colorize()`): the format is tuned for human reading AND `grep` (and AI
 * reading), matching trytami's deliberate "no colors" choice — ANSI escapes break greppability and
 * bunyan's console has none, so color here would also break winston≡bunyan parity.
 *
 * `format.timestamp({format:'HH:mm:ss.SSS'})` supplies the `[time]` slot (`localPrettyFormat` reads
 * `info.timestamp`); millisecond precision, no date (each line already lands in a dated file).
 *
 * `consoleFields`, when given, is the app-chosen ordered ALLOW-LIST of context keys to render locally
 * (hides noise like `requestPath`); GCP still receives every logged key.
 *
 * The service name + version come from {@link ServiceInfo}, but neither RENDERS locally: you already
 * know which service you are running and can check git yourself. They still ship to GCP via the sibling
 * {@link WinstonGcpFactory}. See LOCAL_STRUCTURAL_KEYS in ./format.
 */
export class WinstonConsoleFactory extends WinstonFactoryBase {
    constructor(consoleFields?: string[]) {
        super(
            format.combine(
                bigIntSafeFormat(),
                injectContextFormat(),
                severityFormat(),
                format.timestamp({ format: 'HH:mm:ss.SSS' }),
                localPrettyFormat(consoleFields),
            ),
        );
    }
}
