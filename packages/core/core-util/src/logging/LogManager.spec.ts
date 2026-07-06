import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogManager } from './LogManager';
import { ConsoleLoggerFactory } from './ConsoleLoggerFactory';
import { ConsoleLogger } from './ConsoleLogger';
import { Logger } from './Logger';
import { LoggerFactory } from './LoggerFactory';

/** A trivial in-memory factory used to prove the plug-in seam. */
class RecordingLogger implements Logger {
    public readonly lines: string[] = [];
    constructor(private readonly name: string) {}
    private rec(level: string, message: string): void {
        this.lines.push(`${level} [${this.name}] ${message}`);
    }
    trace(message: string): void { this.rec('trace', message); }
    debug(message: string): void { this.rec('debug', message); }
    info(message: string): void { this.rec('info', message); }
    warn(message: string): void { this.rec('warn', message); }
    error(message: string): void { this.rec('error', message); }
}

class RecordingLoggerFactory implements LoggerFactory {
    public readonly created = new Map<string, RecordingLogger>();
    getLogger(name: string): Logger {
        const logger = new RecordingLogger(name);
        this.created.set(name, logger);
        return logger;
    }
}

describe('LogManager', () => {
    beforeEach(() => {
        // Reset to the default backend before each test (holder is process-wide).
        LogManager.setFactory(new ConsoleLoggerFactory());
    });

    it('returns a ConsoleLogger from the default factory', () => {
        const log = LogManager.getLogger('Default');
        expect(log).toBeInstanceOf(ConsoleLogger);
        expect(LogManager.getFactory()).toBeInstanceOf(ConsoleLoggerFactory);
    });

    it('routes log calls through an installed custom factory', () => {
        const factory = new RecordingLoggerFactory();
        LogManager.setFactory(factory);

        const log = LogManager.getLogger('MyClass');
        log.info('hello');
        log.error('boom');

        const recorded = factory.created.get('MyClass');
        expect(recorded?.lines).toEqual([
            'info [MyClass] hello',
            'error [MyClass] boom',
        ]);
    });

    it('delegates getLogger to whichever factory is currently installed', () => {
        const factory = new RecordingLoggerFactory();
        const spy = vi.spyOn(factory, 'getLogger');
        LogManager.setFactory(factory);

        LogManager.getLogger('A');

        expect(spy).toHaveBeenCalledWith('A');
    });

    afterEach(() => {
        LogManager.setFactory(new ConsoleLoggerFactory());
    });
});

describe('ConsoleLoggerFactory', () => {
    it('caches one logger instance per name', () => {
        const factory = new ConsoleLoggerFactory();
        expect(factory.getLogger('X')).toBe(factory.getLogger('X'));
        expect(factory.getLogger('X')).not.toBe(factory.getLogger('Y'));
    });
});
