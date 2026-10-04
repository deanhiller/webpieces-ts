import { describe, expect, it } from 'vitest';
import { DocumentedAuth, DocumentedAuthMethod } from '@webpieces/api-doc-model';
import { SecurityDeriver } from '../generate/SecurityDeriver';
import { JsonObject } from '../json/JsonObject';

describe('declared credential OR in generated OpenAPI', () => {
    it('keeps the API-key credential pair AND while offering JWT as an alternative', () => {
        const auth = new DocumentedAuth(undefined, [new DocumentedAuthMethod('jwt', [], undefined),new DocumentedAuthMethod('apikey', [], undefined)]);
        const keyPair = new JsonObject().set('PartnerKey', []).set('PartnerOrg', []);
        const requirements = new SecurityDeriver().operation(auth, [keyPair]);
        expect(requirements).toHaveLength(2);
        expect((requirements?.[0] as JsonObject).keys()).toEqual(['WebpiecesJwt']);
        expect((requirements?.[1] as JsonObject).keys()).toEqual(['PartnerKey','PartnerOrg']);
    });

    it('renders service alternatives independently', () => {
        const auth = new DocumentedAuth(undefined, [new DocumentedAuthMethod('oidc', [], undefined),new DocumentedAuthMethod('shared-secret', [], undefined)]);
        const requirements = new SecurityDeriver().operation(auth, undefined);
        expect(requirements).toHaveLength(2);
        expect((requirements?.[0] as JsonObject).keys()).toEqual(['WebpiecesOidc']);
        expect((requirements?.[1] as JsonObject).keys()).toEqual(['WebpiecesSharedSecret']);
    });

    it('does not invent wire headers for an application-owned vendor signature', () => {
        const auth = new DocumentedAuth(undefined, [new DocumentedAuthMethod('jwt', [], undefined),new DocumentedAuthMethod('webhook', ["'vendor'"], undefined)]);
        expect(new SecurityDeriver().operation(auth, undefined)).toBeUndefined();
    });
});
