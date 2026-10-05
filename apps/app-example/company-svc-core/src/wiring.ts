import { AUTH_CONFIG, BindModule, Binder } from '@webpieces/http-routing';
import { CompanyAuthConfig } from './CompanyAuthConfig';

/**
 * CompanyAuthBindModule - the company's shared-secret state for every service: binds the framework
 * AuthConfig (read by AuthFilter for sharedSecret(...) endpoints) to {@link CompanyAuthConfig}, which
 * reads the INTERNAL_API_SECRET values from env. A library BindModule: an app selects it in one line
 * from its own getBindModules(), and tests rebind AuthConfig via appOverrides.
 */
export class CompanyAuthBindModule implements BindModule {
    configure(binder: Binder): void {
        binder.bind(AUTH_CONFIG).to(CompanyAuthConfig).inSingletonScope();
    }
}
