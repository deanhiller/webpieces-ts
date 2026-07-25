import { createLogger, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import type Transport from 'winston-transport';
import type { Format } from 'logform';
import type { Logger, LoggerFactory } from '@webpieces/core-util';
import { WinstonLogger } from './WinstonLogger';

/**
 * WinstonFactoryBase - shared plumbing for the winston {@link LoggerFactory}
 * backends. Builds ONE underlying winston logger (a single `Console` transport,
 * handleExceptions/Rejections on) with the caller-chosen format stack, then hands
 * out a cached {@link WinstonLogger} per name (each a winston child carrying
 * `loggerName`). Subclasses differ only in the format stack they pass up.
 *
 * Neither `svcName` nor `version` is read here: BOTH are stamped per-record by
 * `RequestContext.buildStructuredLogFields` (the one map `injectContextFormat` already loops), so they
 * appear the moment `setInfo` runs — even if that is after this factory was constructed — and logging
 * works before it. This keeps winston and bunyan symmetrical: both read the same two ServiceInfo facts
 * from the same map, on every line. (svcName used to ride as construction-time `defaultMeta`, which
 * silently missed a `setInfo` that ran after the factory was built.)
 */
export abstract class WinstonFactoryBase implements LoggerFactory {
    private readonly base: WinstonBase;
    private readonly loggers = new Map<string, Logger>();

    /**
     * @param transport - the sink to write through. Defaults to a plain Console; the GCP subclass
     *   passes a {@link ChunkingConsoleTransport} instead, because only there does a per-entry size
     *   limit exist. Taking the whole transport (rather than a size knob) keeps the size limit a fact
     *   about the SINK, which is where it actually lives — a dev terminal has no such limit.
     */
    protected constructor(finalFormat: Format, transport?: Transport) {
        // No defaultMeta: svcName + version are BOTH stamped per-record by injectContextFormat (reading
        // RequestContext.buildStructuredLogFields), so they pick up a late setInfo and stay symmetrical
        // with the bunyan backend. No level set — we do NOT filter; that is winston's job (defaults to
        // 'info').
        this.base = createLogger({
            format: finalFormat,
            transports: [transport ?? new transports.Console()],
            handleExceptions: true,
            handleRejections: true,
        });
    }

    getLogger(name: string): Logger {
        let logger = this.loggers.get(name);
        if (!logger) {
            logger = new WinstonLogger(this.base.child({ loggerName: name }));
            this.loggers.set(name, logger);
        }
        return logger;
    }
}
