import { LoggerFactory, ConsoleLoggerFactory, LogManager } from '@webpieces/core-util';

/**
 * CompanyLogging - the company-wide logging bootstrap.
 *
 * Lives in @webpieces/company-core (shared, browser-safe) so every company app
 * configures logging the same way. Each service calls `CompanyLogging.configure()`
 * ONCE at startup (in its server.ts / bootstrap) before other modules fetch their
 * loggers.
 *
 * BROWSER-SAFETY: company-core is `framework:all` (Angular imports it), so this
 * class may only reference the browser-safe {@link ConsoleLoggerFactory}. To plug
 * in a node-only backend (bunyan, winston, a file writer, ...), a
 * `framework:express` app passes its own {@link LoggerFactory} here — the
 * node-only factory itself must NOT live in this browser-safe library.
 */
export class CompanyLogging {
    /**
     * Install the process-wide logging backend for a company app.
     *
     * @param factory - The logging backend to install. Defaults to the
     *   browser-safe console backend, which is what browser apps (Angular/React)
     *   use. Express services may pass a node-only factory (bunyan/winston/...).
     */
    static configure(factory: LoggerFactory = new ConsoleLoggerFactory()): void {
        LogManager.setFactory(factory);
    }
}
