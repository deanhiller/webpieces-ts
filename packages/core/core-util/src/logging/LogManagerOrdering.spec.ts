import { describe, it, expect } from 'vitest';
import { LogManager } from './LogManager';
import { ConsoleLoggerFactory } from './ConsoleLoggerFactory';
import { HeaderRegistry } from '../http/HeaderRegistry';

/**
 * This file NEVER configures the HeaderRegistry (vitest isolates module state per file),
 * so it proves the fail-fast ordering contract: LogManager.setFactory refuses to run
 * until HeaderRegistry.configure(...) has been called.
 */
describe('LogManager ↔ HeaderRegistry ordering', () => {
    it('setFactory throws when HeaderRegistry is not configured yet', () => {
        expect(HeaderRegistry.isConfigured()).toBe(false);
        expect(() => LogManager.setFactory(new ConsoleLoggerFactory())).toThrow(
            /HeaderRegistry\.configure\(\.\.\.\) MUST be called before LogManager\.setFactory/,
        );
    });

    it('setFactory succeeds once the registry is configured', () => {
        HeaderRegistry.configure([], /*platformHeaders*/ true);
        expect(() => LogManager.setFactory(new ConsoleLoggerFactory())).not.toThrow();
    });
});
