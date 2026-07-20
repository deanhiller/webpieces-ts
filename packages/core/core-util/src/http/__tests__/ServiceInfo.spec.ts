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
 * both logging backends AND by RequestContextHeaders (requestIdSource + outbound clientVersion).
 */
describe('ServiceInfo identifies this service exactly once, at startup', () => {
    it('round-trips name AND version', () => {
        ServiceInfo.setInfo('my-service', '2.1.0');

        expect(ServiceInfo.getName()).toBe('my-service');
        expect(ServiceInfo.getVersion()).toBe('2.1.0');
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

        expect(ServiceInfo.getName()).toBeUndefined();
        expect(ServiceInfo.getVersion()).toBeUndefined();
    });
});

/**
 * The failure design: READS never throw (a missing log field must not 500 live traffic, and logging
 * must work before setInfo), so a pre-`setInfo` log line still emits. The "a deployed build must say
 * which build it is" guarantee is enforced by making name+version REQUIRED inputs to setInfo (which
 * `setupRuntime` takes and calls) — a blank value throws at startup rather than shipping anonymously.
 */
describe('ServiceInfo reads never throw; setInfo fails fast on blank identity', () => {
    it('getName()/getVersion() return undefined when never set — the request path never blows up', () => {
        expect(ServiceInfo.getName()).toBeUndefined();
        expect(ServiceInfo.getVersion()).toBeUndefined();
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

        expect(ServiceInfo.getName()).toBeUndefined();
        expect(ServiceInfo.getVersion()).toBeUndefined();
    });
});
