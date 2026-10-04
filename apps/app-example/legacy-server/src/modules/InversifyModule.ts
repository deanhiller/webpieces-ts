import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { Counter, SimpleCounter } from '../controllers/save-controller';
import { TYPES } from '../remote/Server2Client';
import { ContextKey, AnyContextKey, Secrets, SECRETS } from '@webpieces/core-util';
import { AUTH_CONFIG, JWT_HOOK } from '@webpieces/http-routing';
import { CompanyAuthConfig, CompanyJwtHook } from '@webpieces/company-svc-core';

/**
 * App-specific headers for the legacy server (third tier of the three-tier header
 * system, after framework core + company headers). An instance class (not statics)
 * so it obeys no-function-outside-class — construct one and read getAllHeaders().
 */
export class AppHeaders {
    readonly CLIENT_TYPE = ContextKey.untrusted<string>('clientType', 'x-client-type');

    getAllHeaders(): AnyContextKey[] {
        return [this.CLIENT_TYPE];
    }
}

/**
 * InversifyModule - the legacy server's DI configuration. Controllers/filters with
 * @provideSingleton() are auto-registered; this module binds the manual pieces:
 * the Counter, the AuthConfig impl, the shared-secret store, and the PROD Server2Api
 * client. Copied into legacy-server so it does not depend on the greenfield app.
 */
export const InversifyModule = new ContainerModule((options: ContainerModuleLoadOptions) => {
    const bind = options.bind;

    bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();

    // Shared-secret state: the framework AuthFilter injects AuthConfig for sharedSecret(...).
    // Tests rebind AuthConfig to a stub / test-key config via appOverrides.
    bind(AUTH_CONFIG).to(CompanyAuthConfig).inSingletonScope();

    // User JWT mechanism: the framework AuthFilter injects JwtHook for jwt() endpoints.
    // Tests rebind JwtHook to a permissive stub via appOverrides. (OIDC is the framework default.)
    bind(JWT_HOOK).to(CompanyJwtHook).inSingletonScope();

    // The ONE shared-secret store for this service's outbound clients.
    const secrets = new Secrets({ INTERNAL_API_SECRET: process.env['INTERNAL_API_SECRET'] });
    bind(SECRETS).toConstantValue(secrets);
});
