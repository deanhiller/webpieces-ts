import { createLogger, transports } from 'winston';
import type { Logger as WinstonBase } from 'winston';
import type { Format } from 'logform';
import type { Logger, LoggerFactory } from '@webpieces/core-util';
import { ServiceInfo } from '@webpieces/core-util';
import { WinstonLogger } from './WinstonLogger';
import { WinstonFactoryOptions } from './WinstonFactoryOptions';

/**
 * WinstonFactoryBase - shared plumbing for the winston {@link LoggerFactory}
 * backends. Builds ONE underlying winston logger (a single `Console` transport,
 * handleExceptions/Rejections on) with the caller-chosen format stack, then hands
 * out a cached {@link WinstonLogger} per name (each a winston child carrying
 * `loggerName`). Subclasses differ only in the format stack they pass up.
 *
 * Every line carries `svcName` from {@link ServiceInfo}. Winston, unlike bunyan, has
 * NO mandatory logger name, so this backend used to emit no service name at all — a
 * winston service was distinguishable only by GCP's own resource labels. Now both
 * backends read the SAME {@link ServiceInfo}, so naming is a property of the service
 * rather than of the logging library the app happened to pick.
 */
export abstract class WinstonFactoryBase implements LoggerFactory {
    private readonly base: WinstonBase;
    private readonly loggers = new Map<string, Logger>();

    protected constructor(finalFormat: Format, opts: WinstonFactoryOptions) {
        // Read at STARTUP (this ctor runs while booting), so a forgotten ServiceInfo.setName(...)
        // fails the deploy rather than shipping unnamed logs.
        const defaultMeta: Record<string, string> = { svcName: ServiceInfo.getName() };
        if (opts.svcGitHash) {
            defaultMeta['svcGitHash'] = opts.svcGitHash;
        }

        // No level set — we do NOT filter; that is winston's job (defaults to 'info').
        this.base = createLogger({
            format: finalFormat,
            defaultMeta: defaultMeta,
            transports: [new transports.Console()],
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
