import { PlatformHeader } from '../PlatformHeader';
import { PlatformHeadersExtension } from '../PlatformHeadersExtension';
import { HeaderRegistry } from '../HeaderRegistry';

function registryOf(...headerGroups: PlatformHeader[][]): HeaderRegistry {
    const extensions = headerGroups.map((headers: PlatformHeader[]) => new PlatformHeadersExtension(headers));
    return new HeaderRegistry(extensions);
}

describe('HeaderRegistry', () => {
    it('collects headers across multiple extensions', () => {
        const tenant = new PlatformHeader('x-tenant-id');
        const auth = new PlatformHeader('authorization', true, true);
        const registry = registryOf([tenant], [auth]);

        expect(registry.getHeaders()).toHaveLength(2);
        expect(registry.findByName('X-Tenant-Id')).toBe(tenant); // case-insensitive
    });

    it('collapses exact duplicate definitions to one entry', () => {
        const a = new PlatformHeader('x-tenant-id', true, false, true, 'tenantId');
        const b = new PlatformHeader('x-tenant-id', true, false, true, 'tenantId');
        const registry = registryOf([a], [b]);

        expect(registry.getHeaders()).toHaveLength(1);
    });

    it('throws when two modules disagree on isSecured for the same header name', () => {
        const open = new PlatformHeader('x-api-key', true, false);
        const secured = new PlatformHeader('x-api-key', true, true);

        expect(() => registryOf([open], [secured])).toThrow(/Conflicting PlatformHeader definitions for 'x-api-key'.*isSecured/);
    });

    it('throws when two modules disagree on isWantTransferred for the same header name', () => {
        const transferred = new PlatformHeader('x-flag', true);
        const local = new PlatformHeader('x-flag', false);

        expect(() => registryOf([transferred, local])).toThrow(/isWantTransferred/);
    });

    it('throws when two modules disagree on loggerMdcKey for the same header name', () => {
        const withKey = new PlatformHeader('x-req', true, false, false, 'requestId');
        const otherKey = new PlatformHeader('x-req', true, false, false, 'reqId');

        expect(() => registryOf([withKey], [otherKey])).toThrow(/loggerMdcKey/);
    });

    it('throws when two DIFFERENT headers claim the same loggerMdcKey', () => {
        const first = new PlatformHeader('x-request-id', true, false, false, 'requestId');
        const second = new PlatformHeader('x-req-id-alt', true, false, false, 'requestId');

        expect(() => registryOf([first, second])).toThrow(/Duplicate PlatformHeader loggerMdcKey 'requestId'/);
    });

    it('getTransferredHeaders filters to isWantTransferred=true', () => {
        const transferred = new PlatformHeader('x-a', true);
        const local = new PlatformHeader('x-b', false);
        const registry = registryOf([transferred, local]);

        expect(registry.getTransferredHeaders()).toEqual([transferred]);
    });

    it('getSecuredNames and getMdcHeaders expose the right subsets', () => {
        const auth = new PlatformHeader('authorization', true, true);
        const reqId = new PlatformHeader('x-request-id', true, false, true, 'requestId');
        const plain = new PlatformHeader('x-plain');
        const registry = registryOf([auth, reqId, plain]);

        expect(registry.getSecuredNames()).toEqual(['authorization']);
        expect(registry.getMdcHeaders()).toEqual([reqId]);
    });
});
