import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
    ApiPath,
    Endpoint,
    EXTERNAL_OUTBOUND,
    GET,
    READ,
    RPC,
    WpAuthPublic,
    isExternalOutboundApi,
} from '../decorators';
import { AuthorizationType, WpAuthorization } from '../authorization';
import { ContextKey } from '../../ContextKey';
import { DestinationTrust } from '../DestinationTrust';
import { ExternalContextKeys, getExternalContextKeys } from '../ExternalContextKeys';
import { RouteMetadataFactory } from '../RouteMetadataFactory';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';

const MERCHANT = ContextKey.untrusted<string>('outboundSpecMerchant', 'x-merchant', true);
const STORE = ContextKey.untrusted<string>('outboundSpecStore', 'x-store', true);
const UNRELATED = ContextKey.untrusted<string>('outboundSpecUnrelated', 'x-unrelated', true);

@ApiPath('/v1')
@ExternalContextKeys(WebpiecesCoreHeaders.REQUEST_ID, MERCHANT)
abstract class VendorApi {
    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/items', READ, EXTERNAL_OUTBOUND)
    items(): Promise<object> {
        throw new Error('contract');
    }

    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/stores', READ, EXTERNAL_OUTBOUND)
    @ExternalContextKeys(STORE)
    stores(): Promise<object> {
        throw new Error('contract');
    }
}

@ApiPath('/mixed')
abstract class MixedApi {
    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/out', READ, EXTERNAL_OUTBOUND)
    out(): Promise<object> {
        throw new Error('contract');
    }

    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/ours', READ, RPC)
    ours(): Promise<object> {
        throw new Error('contract');
    }
}

@ApiPath('/ours')
@ExternalContextKeys(MERCHANT)
abstract class OursWithKeysApi {
    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/x', READ, RPC)
    x(): Promise<object> {
        throw new Error('contract');
    }
}

@ApiPath('/plain')
abstract class OursApi {
    @WpAuthPublic('Outbound fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Outbound fixture' })
    @Endpoint(GET, '/x', READ, RPC)
    x(): Promise<object> {
        throw new Error('contract');
    }
}

describe('EXTERNAL_OUTBOUND contracts and @ExternalContextKeys', () => {
    it('merges class-level keys with a method’s own, and marks the route outbound', () => {
        expect(isExternalOutboundApi(VendorApi)).toBe(true);
        expect(getExternalContextKeys(VendorApi, 'items')).toEqual([WebpiecesCoreHeaders.REQUEST_ID, MERCHANT]);
        expect(getExternalContextKeys(VendorApi, 'stores')).toEqual([
            WebpiecesCoreHeaders.REQUEST_ID,
            MERCHANT,
            STORE,
        ]);
        const route = RouteMetadataFactory.create(VendorApi, 'stores');
        expect(route.externalOutbound).toBe(true);
        expect(route.externalContextKeys).toEqual([WebpiecesCoreHeaders.REQUEST_ID, MERCHANT, STORE]);
    });

    it('an outbound destination allows ONLY listed keys and believes no response header', () => {
        const destination = DestinationTrust.forRoute(RouteMetadataFactory.create(VendorApi, 'items'));
        expect(destination.allows(MERCHANT)).toBe(true);
        expect(destination.allows(UNRELATED)).toBe(false);
        expect(destination.allows(WebpiecesCoreHeaders.CLIENT_VERSION)).toBe(false);
        expect(destination.believesResponse(WebpiecesCoreHeaders.REQUEST_ID)).toBe(false);
        expect(destination.listedKeys()).toEqual([WebpiecesCoreHeaders.REQUEST_ID, MERCHANT]);
    });

    it('a route of ours keeps the auth-mode destination, unchanged', () => {
        const ours = DestinationTrust.forRoute(RouteMetadataFactory.create(OursApi, 'x'));
        expect(ours.listedKeys()).toBeUndefined();
        expect(ours.allows(UNRELATED)).toBe(true);
        expect(ours.believesResponse(UNRELATED)).toBe(true);
    });

    it('refuses a contract mixing EXTERNAL_OUTBOUND with another kind', () => {
        expect(() => RouteMetadataFactory.create(MixedApi, 'out')).toThrow(
            'MixedApi mixes EXTERNAL_OUTBOUND (out) with RPC (ours).',
        );
    });

    it('refuses @ExternalContextKeys on a contract this repo serves', () => {
        expect(() => RouteMetadataFactory.create(OursWithKeysApi, 'x')).toThrow(
            'OursWithKeysApi declares @ExternalContextKeys but is not an EXTERNAL_OUTBOUND contract.',
        );
    });

    it('refuses a listed key with no wire name', () => {
        const noHeader = ContextKey.untrusted<string>('outboundSpecNoHeader');
        expect(() => ExternalContextKeys(noHeader)).toThrow(
            "@ExternalContextKeys: ContextKey 'outboundSpecNoHeader' declares no httpHeader",
        );
    });
});
