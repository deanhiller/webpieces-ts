import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { LogManager } from './LogManager';
import { ConsoleLoggerFactory } from './ConsoleLoggerFactory';
import { Logger } from './Logger';
import { LoggerFactory } from './LoggerFactory';
import { HeaderRegistry } from '../http/HeaderRegistry';

// LogManager.setFactory fails fast unless the HeaderRegistry is configured first.
beforeAll(() => {
    HeaderRegistry.configure([], [], /*platformHeaders*/ true);
});

/** A trivial in-memory factory used to prove the plug-in seam. Caches per name,
 * like every real factory (ConsoleLoggerFactory / bunyan / winston). */
class RecordingLogger implements Logger {
    public readonly lines: string[] = [];
    constructor(private readonly name: string) {}
    private rec(level: string, message: string, err?: Error): void {
        this.lines.push(`${level} [${this.name}] ${message}${err ? ` err=${err.message}` : ''}`);
    }
    trace(message: string, err?: Error): void { this.rec('trace', message, err); }
    debug(message: string, err?: Error): void { this.rec('debug', message, err); }
    info(message: string, err?: Error): void { this.rec('info', message, err); }
    warn(message: string, err?: Error): void { this.rec('warn', message, err); }
    error(message: string, err?: Error): void { this.rec('error', message, err); }
}

class RecordingLoggerFactory implements LoggerFactory {
    public readonly created = new Map<string, RecordingLogger>();
    getLogger(name: string): Logger {
        let logger = this.created.get(name);
        if (!logger) {
            logger = new RecordingLogger(name);
            this.created.set(name, logger);
        }
        return logger;
    }
}

describe('LogManager', () => {
    beforeEach(() => {
        LogManager.setFactory(new ConsoleLoggerFactory());
    });
    afterEach(() => {
        vi.restoreAllMocks();
        LogManager.setFactory(new ConsoleLoggerFactory());
    });

    it('routes log calls through an installed custom factory', () => {
        const factory = new RecordingLoggerFactory();
        LogManager.setFactory(factory);

        const log = LogManager.getLogger('MyClass');
        log.info('hello');
        log.error('boom', new Error('bad'));

        expect(factory.created.get('MyClass')?.lines).toEqual([
            'info [MyClass] hello',
            'error [MyClass] boom err=bad',
        ]);
    });

    it('a logger obtained BEFORE setFactory uses the backend installed AFTER', () => {
        // Captured under the default console factory (the import-time scenario).
        const log = LogManager.getLogger('Early');

        const factory = new RecordingLoggerFactory();
        LogManager.setFactory(factory);

        log.info('after');
        expect(factory.created.get('Early')?.lines).toEqual(['info [Early] after']);
    });

    it('resolves the backend lazily (per call), not at getLogger time', () => {
        const factory = new RecordingLoggerFactory();
        const spy = vi.spyOn(factory, 'getLogger');
        LogManager.setFactory(factory);

        const log = LogManager.getLogger('A');
        expect(spy).not.toHaveBeenCalled();

        log.info('x');
        expect(spy).toHaveBeenCalledWith('A');
    });

    it('default/reset factory is the browser-safe ConsoleLoggerFactory', () => {
        expect(LogManager.getFactory()).toBeInstanceOf(ConsoleLoggerFactory);
    });
});

describe('ConsoleLoggerFactory', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('caches one logger instance per name', () => {
        const factory = new ConsoleLoggerFactory();
        expect(factory.getLogger('X')).toBe(factory.getLogger('X'));
        expect(factory.getLogger('X')).not.toBe(factory.getLogger('Y'));
    });

    it('bootstrap factory prefixes the AWAITING banner; a normal one does not', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        new ConsoleLoggerFactory(true).getLogger('B').info('hi');
        new ConsoleLoggerFactory().getLogger('B').info('hi');
        expect(String(spy.mock.calls[0][0])).toContain('AWAITING LogManager.setFactory');
        expect(String(spy.mock.calls[1][0])).not.toContain('AWAITING');
    });

    it('forwards an Error to the console for stack rendering', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const err = new Error('kaboom');
        new ConsoleLoggerFactory().getLogger('C').error('failed', err);
        expect(spy.mock.calls[0]).toContain(err);
    });
});
