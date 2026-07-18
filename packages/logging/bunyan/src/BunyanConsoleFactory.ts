import { BunyanFactoryBase } from './BunyanFactoryBase';
import { createConsoleStream } from './streams';

/**
 * BunyanConsoleFactory - the LOCAL developer backend. Human-readable, greppable
 * text to stdout (`[LEVEL][time][Controller.method][loggerName][ctx tags]: message`) with the
 * registered context keys as tags — same enrichment as the GCP backend, different rendering. Mirrors
 * the tested trytami local console stream.
 *
 * `consoleFields`, when given, is the app-chosen ordered ALLOW-LIST of context keys to render in the
 * console line (hides local noise like `requestPath`); GCP still receives every logged key.
 *
 * The service name + version come from {@link ServiceInfo}, which startup must have populated
 * BEFORE constructing this.
 */
export class BunyanConsoleFactory extends BunyanFactoryBase {
    constructor(consoleFields?: string[]) {
        super([createConsoleStream(consoleFields)]);
    }
}
