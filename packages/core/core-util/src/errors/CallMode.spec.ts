import { describe, expect, it } from 'vitest';
import { ApiConnectionError } from './ApiError';
import { CallMode, CallModeMarker } from './CallMode';
import { RouteMetadata } from '../http/RouteMetadata';
import { READ } from '../http/HttpEndpointOptions';

describe('CallModeMarker (#1293)', () => {
    it('parks the mode as a non-enumerable property and keeps the instance and class', () => {
        const error = new ApiConnectionError('down');

        CallModeMarker.attachTo(error, CallMode.BACKGROUND);

        expect(error).toBeInstanceOf(ApiConnectionError);
        expect(error.callMode).toBe(CallMode.BACKGROUND);
        expect(CallModeMarker.of(error)).toBe(CallMode.BACKGROUND);
        expect(Object.keys(error)).not.toContain('callMode');
        expect(JSON.stringify(error)).not.toContain('BACKGROUND');
    });

    it('never clobbers an existing mode', () => {
        const error = new Error('inner');
        CallModeMarker.attachTo(error, CallMode.BACKGROUND);
        CallModeMarker.attachTo(error, CallMode.FOREGROUND);
        expect(CallModeMarker.of(error)).toBe(CallMode.BACKGROUND);
    });

    it('leaves non-Errors and frozen errors alone', () => {
        const frozen = Object.freeze(new Error('frozen'));
        CallModeMarker.attachTo(frozen, CallMode.BACKGROUND);
        CallModeMarker.attachTo('a string', CallMode.BACKGROUND);
        expect(CallModeMarker.of(frozen)).toBeUndefined();
        expect(CallModeMarker.of('a string')).toBeUndefined();
        expect(CallModeMarker.of(new Error('never failed a client call'))).toBeUndefined();
    });
});

describe('RouteMetadata.withCallMode (#1293)', () => {
    const declared = new RouteMetadata('POST', '/items/list', 'list', READ);

    it('FOREGROUND returns the declared route unchanged', () => {
        expect(declared.withCallMode(CallMode.FOREGROUND)).toBe(declared);
        expect(declared.callMode).toBe(CallMode.FOREGROUND);
        expect(declared.hideProgress).toBe(false);
    });

    it('BACKGROUND is a per-call copy that hides progress, leaving the declared route alone', () => {
        const background = declared.withCallMode(CallMode.BACKGROUND);
        expect(background).not.toBe(declared);
        expect(background.callMode).toBe(CallMode.BACKGROUND);
        expect(background.hideProgress).toBe(true);
        expect(background.path).toBe('/items/list');
        expect(background.operation).toBe(READ);
        expect(declared.hideProgress).toBe(false);
        expect(declared.callMode).toBe(CallMode.FOREGROUND);
    });
});
