import { describe, it, expect } from 'vitest';
import { ApiCallSite } from './ApiCallSite';
import { ApiImplementationError } from './ApiError';
import { ReportableApiFailure, RpcCallFailed } from './ReportableApiFailure';

/** A stand-in for a generated client method: captures on entry, exactly as the proxies do. */
class FakeClient {
    readonly save = (): ApiCallSite => ApiCallSite.capture('SaveApi', 'save', this.save);
}

// webpieces-disable no-function-outside-class -- a NAMED caller frame is what the stack must show
function appCodeThatCallsSave(client: FakeClient): ApiCallSite {
    return client.save();
}

describe('ApiCallSite (#1175)', () => {
    it('captures the CALLER: the named app frame is on the stack and the client method is trimmed', () => {
        const site = appCodeThatCallsSave(new FakeClient());
        const frames = (site.stack ?? '').split('\n').slice(1);
        expect(frames[0]).toContain('appCodeThatCallsSave');
        expect(site.label).toBe('SaveApi.save');
        expect(site).toBeInstanceOf(Error);
    });

    it('attaches NON-enumerably to the same instance; JSON and Object.keys never see it', () => {
        const failure = new ApiImplementationError('boom');
        const site = appCodeThatCallsSave(new FakeClient());
        site.attachTo(failure);

        expect(failure.callSite).toBe(site);
        expect(ApiCallSite.of(failure)).toBe(site);
        expect(Object.keys(failure)).not.toContain('callSite');
        expect(JSON.stringify(failure)).not.toContain('callSite');
    });

    it('never clobbers an existing call site — the innermost call wins', () => {
        const failure = new ApiImplementationError('boom');
        const inner = appCodeThatCallsSave(new FakeClient());
        const outer = appCodeThatCallsSave(new FakeClient());
        inner.attachTo(failure);
        outer.attachTo(failure);
        expect(failure.callSite).toBe(inner);
    });

    it('skips a frozen error and a non-Error rejection without throwing', () => {
        const frozen = Object.freeze(new ApiImplementationError('frozen'));
        const site = appCodeThatCallsSave(new FakeClient());
        expect(() => site.attachTo(frozen)).not.toThrow();
        expect(ApiCallSite.of(frozen)).toBeUndefined();
        expect(() => site.attachTo('a string')).not.toThrow();
        expect(ApiCallSite.of('a string')).toBeUndefined();
    });

    it('an error that never failed a client call carries no callSite key at all', () => {
        const failure = new ApiImplementationError('plain');
        expect(failure.callSite).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(failure, 'callSite')).toBe(false);
    });
});

describe('ReportableApiFailure.toReportableError (#1175)', () => {
    it('wraps with the call-site stack, cause = the original, and an endpoint fingerprint', () => {
        const failure = new ApiImplementationError('downstream said 500');
        appCodeThatCallsSave(new FakeClient()).attachTo(failure);

        const report = ReportableApiFailure.toReportableError(failure);

        expect(report).toBeDefined();
        const wrapper = report!.error;
        expect(wrapper).toBeInstanceOf(RpcCallFailed);
        expect(wrapper.name).toBe('RpcCallFailed');
        expect(wrapper.message).toBe('SaveApi.save failed: downstream said 500');
        expect(wrapper.cause).toBe(failure);
        const lines = (wrapper.stack ?? '').split('\n');
        expect(lines[0]).toBe('RpcCallFailed: SaveApi.save failed: downstream said 500');
        expect(lines[1]).toContain('appCodeThatCallsSave');
        expect(report!.fingerprint).toEqual(['ApiImplementationError', 'SaveApi.save']);
    });

    it('returns undefined for a failure no generated client touched — report it as it is', () => {
        expect(ReportableApiFailure.toReportableError(new Error('local'))).toBeUndefined();
        expect(ReportableApiFailure.toReportableError(undefined)).toBeUndefined();
    });
});
