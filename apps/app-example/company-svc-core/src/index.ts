/**
 * @webpieces/company-svc-core
 *
 * Company-wide shared SERVER core (node-only, framework:express). Holds the one
 * shared server bootstrap + shared server DI so every express service starts the
 * same way. NOT browser-safe and NOT imported by Angular — that is what the
 * browser-safe @webpieces/company-core is for.
 */

export { bootstrapServer, createCompanyRouter, configureCompanyHeaders, setupCompanyRuntime } from './bootstrapServer';
export { BootstrapOptions } from './BootstrapOptions';
export { CompanySetupOptions } from './CompanySetupOptions';
export { CompanyAuthConfig } from './CompanyAuthConfig';
