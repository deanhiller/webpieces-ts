import { createLogger, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import type Transport from 'winston-transport';
import type { Format } from 'logform';
import type { Logger, LoggerFactory } from '@webpieces/core-util';
import { ServiceInfo } from '@webpieces/core-util';
import { WinstonLogger } from './WinstonLogger';

/**
 * WinstonFactoryBase - shared plumbing for the winston {@link LoggerFactory}
 * backends. Builds ONE underlying winston logger (a single `Console` transport,
 * handleExceptions/Rejections on) with the caller-chosen format stack, then hands
 * out a cached {@link WinstonLogger} per name (each a winston child carrying
 * `loggerName`). Subclasses differ only in the format stack they pass up.
 *
 * Every line carries `svcName` from {@link ServiceInfo} (winston has no mandatory logger name, so this
 * backend used to emit none — a winston service was distinguishable only by GCP's own resource
 * labels). It is read here at construction and rides as `defaultMeta`; it is simply absent if the
 * service was not identified before this factory was built.
 *
 * `version` is NOT read here: it is stamped per-record by `RequestContext.buildStructuredLogFields`
 * (the one map `injectContextFormat` already loops), so it appears the moment `setInfo` runs — even
 * if that is after this factory was constructed — and logging works before it.
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
        // svcName is a base field on every record when known. Non-throwing read: if the service was
        // not identified before this factory was built, svcName is simply omitted rather than blocking
        // the deploy — setupRuntime enforces identity separately via ServiceInfo.assertIdentified().
        const svcName = ServiceInfo.getName();
        const defaultMeta: Record<string, string> = {};
        if (svcName) {
            defaultMeta['svcName'] = svcName;
        }

        // No level set — we do NOT filter; that is winston's job (defaults to 'info').
        this.base = createLogger({
            format: finalFormat,
            defaultMeta: defaultMeta,
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
