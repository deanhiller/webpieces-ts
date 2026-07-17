import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServiceInfo } from '../ServiceInfo';

beforeEach(() => {
    ServiceInfo.clear();
});

afterEach(() => {
    ServiceInfo.clear();
});

/**
 * "What service am I" used to exist only as a side effect of picking bunyan (which REQUIRES a
 * root-logger name); a winston app shipped unnamed. ServiceInfo makes it one framework-level fact,
 * read by both logging backends AND by RequestContextHeaders (to stamp requestIdSource).
 */
describe('ServiceInfo names this service exactly once, at startup', () => {
    it('round-trips the name to both readers', () => {
        ServiceInfo.setName('my-service');

        expect(ServiceInfo.getName()).toBe('my-service');
        expect(ServiceInfo.tryGetName()).toBe('my-service');
    });

    /**
     * The whole failure design: getName() is called by the logger factories + setupRuntime, all of
     * which run while BOOTING. So a forgotten setName kills the deploy, and the message must say
     * exactly what to do rather than surfacing bunyan's opaque "options.name (string) is required".
     */
    it('getName() THROWS an actionable error when never named — the startup fail-fast', () => {
        expect(() => ServiceInfo.getName()).toThrow(/ServiceInfo\.setName\(\.\.\.\) has not been called/);
        expect(() => ServiceInfo.getName()).toThrow(/BEFORE constructing the logger factory/);
    });

    /**
     * The REQUEST path reads this, and it must never throw: a missing log field must not 500 live
     * traffic. Any real server has already passed setupRuntime's getName() check, so undefined here
     * only ever means "a unit test drove the context directly".
     */
    it('tryGetName() returns undefined instead of throwing — the request path never blows up', () => {
        expect(ServiceInfo.tryGetName()).toBeUndefined();
    });

    it('rejects a blank name — always a bug, never a use case', () => {
        expect(() => ServiceInfo.setName('')).toThrow(/non-blank/);
        expect(() => ServiceInfo.setName('   ')).toThrow(/non-blank/);
    });

    /**
     * LAST CALL WINS. An in-process test can legitimately boot two services back-to-back (the
     * app-example e2e two-server flow does exactly this), so a "one process = one name" rule would
     * reject a case that genuinely exists.
     */
    it('a second, DIFFERENT name wins rather than throwing — two servers can boot in one process', () => {
        ServiceInfo.setName('server-one');
        ServiceInfo.setName('server-two');

        expect(ServiceInfo.getName()).toBe('server-two');
    });
});
