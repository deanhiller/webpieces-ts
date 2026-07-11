import { injectable } from 'inversify';
import { AuthConfig, SharedSecrets } from '@webpieces/http-routing';

/**
 * CompanyAuthConfig - the company's shared-secret STATE, bound to the framework {@link AuthConfig}.
 * It holds ONLY the accepted @AuthSharedSecret values; the JWT mechanism lives on
 * {@link CompanyJwtHook} and OIDC is the framework default ({@link DefaultOidcVerifier}).
 *
 * Prod reads the expected secret VALUES from env by the @AuthSharedSecret name. Two slots so a
 * secret can be ROTATED with zero dropped requests (either passes): shift _2 → _1 on rotation.
 * Tests rebind AuthConfig to a stub with fixed values.
 */
@injectable()
export class CompanyAuthConfig extends AuthConfig {
    constructor() {
        super({
            INTERNAL_API_SECRET: new SharedSecrets(
                process.env['INTERNAL_API_SECRET'] ?? '',
                process.env['INTERNAL_API_SECRET_2'] ?? '',
            ),
        });
    }
}
