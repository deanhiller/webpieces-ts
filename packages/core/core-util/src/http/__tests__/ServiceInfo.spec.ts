import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServiceInfo } from '../ServiceInfo';

beforeEach(() => {
    ServiceInfo.clear();
});

afterEach(() => {
    ServiceInfo.clear();
});

/**
 * "What service am I, and which build?" used to be a side effect of which logging library you
 * picked: the name existed only under bunyan (which REQUIRES a root-logger name, so a winston app
 * shipped unnamed), and the version existed only under winston (as an optional `svcGitHash`, so a
 * bunyan app could not stamp one at all). ServiceInfo makes both ONE framework-level fact, read by
 * both logging backends AND by RequestContextHeaders (to stamp requestIdSource).
 */
describe('ServiceInfo identifies this service exactly once, at startup', () => {
    it('round-trips name AND version to both readers', () => {
        ServiceInfo.setInfo('my-service', '2.1.0');

        expect(ServiceInfo.getName()).toBe('my-service');
        expect(ServiceInfo.tryGetName()).toBe('my-service');
        expect(ServiceInfo.getVersion()).toBe('2.1.0');
        expect(ServiceInfo.tryGetVersion()).toBe('2.1.0');
    });

    /**
     * The version is OPAQUE: webpieces neither parses nor derives it. The field it replaced was
     * named `svcGitHash`, which misdescribed every project that deploys semver or CI build numbers
     * rather than raw SHAs — so a non-SHA must round-trip untouched.
     */
    it('takes any opaque build identifier, not just a git SHA', () => {
        ServiceInfo.setInfo('my-service', 'v3.2.1-rc4');
        expect(ServiceInfo.getVersion()).toBe('v3.2.1-rc4');

        ServiceInfo.setInfo('my-service', '4711');
        expect(ServiceInfo.getVersion()).toBe('4711');
    });

    /**
     * LAST CALL WINS. An in-process test can legitimately boot two services back-to-back (the
     * app-example e2e two-server flow does exactly this), so a "one process = one service" rule
     * would reject a case that genuinely exists.
     */
    it('a second, DIFFERENT identity wins rather than throwing — two servers can boot in one process', () => {
        ServiceInfo.setInfo('server-one', '1.0.0');
        ServiceInfo.setInfo('server-two', '2.0.0');

        expect(ServiceInfo.getName()).toBe('server-two');
        expect(ServiceInfo.getVersion()).toBe('2.0.0');
    });

    it('clear() resets both halves', () => {
        ServiceInfo.setInfo('my-service', '2.1.0');
        ServiceInfo.clear();

        expect(ServiceInfo.tryGetName()).toBeUndefined();
        expect(ServiceInfo.tryGetVersion()).toBeUndefined();
    });
});

/**
 * The failure design, in one line: throw while BOOTING, never mid-traffic. getName()/getVersion()
 * are called by the logger factories + setupRuntime, all of which run at startup — so a forgotten
 * setInfo kills the deploy. The request path uses the tryGet* pair and simply omits the field.
 */
describe('ServiceInfo fails fast at startup, never on the request path', () => {
    /**
     * The message must say exactly what to do rather than surfacing bunyan's opaque
     * "options.name (string) is required".
     */
    it('getName() THROWS an actionable error when never set', () => {
        expect(() => ServiceInfo.getName()).toThrow(/ServiceInfo\.setInfo\(\.\.\.\) has not been called/);
        expect(() => ServiceInfo.getName()).toThrow(/BEFORE constructing the logger factory/);
    });

    /** Same fail-fast for the version half — an unversioned deploy is the thing this prevents. */
    it('getVersion() THROWS the same actionable error when never set', () => {
        expect(() => ServiceInfo.getVersion()).toThrow(/ServiceInfo\.setInfo\(\.\.\.\) has not been called/);
        expect(() => ServiceInfo.getVersion()).toThrow(/BEFORE constructing the logger factory/);
    });

    /**
     * A missing log field must not 500 live traffic. Any real server has already passed
     * setupRuntime's checks, so undefined here only ever means "a unit test drove the context
     * directly".
     */
    it('tryGet*() return undefined instead of throwing — the request path never blows up', () => {
        expect(ServiceInfo.tryGetName()).toBeUndefined();
        expect(ServiceInfo.tryGetVersion()).toBeUndefined();
    });

    it('rejects a blank name — always a bug, never a use case', () => {
        expect(() => ServiceInfo.setInfo('', '2.1.0')).toThrow(/non-blank service name/);
        expect(() => ServiceInfo.setInfo('   ', '2.1.0')).toThrow(/non-blank service name/);
    });

    it('rejects a blank version — every deployed build must say which build it is', () => {
        expect(() => ServiceInfo.setInfo('my-service', '')).toThrow(/non-blank version/);
        expect(() => ServiceInfo.setInfo('my-service', '   ')).toThrow(/non-blank version/);
    });

    /**
     * A blank version must not leave the name half-applied: a caller that catches the throw and
     * carries on would otherwise boot a NAMED service with no version, which is precisely the state
     * setInfo exists to make impossible.
     */
    it('leaves BOTH unset when validation fails — no half-applied state', () => {
        expect(() => ServiceInfo.setInfo('my-service', '')).toThrow();

        expect(ServiceInfo.tryGetName()).toBeUndefined();
        expect(ServiceInfo.tryGetVersion()).toBeUndefined();
    });
});
