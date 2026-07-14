import { ServiceUrlDeriver } from './ClientRegistry';

/**
 * A {@link ServiceUrlDeriver} for any environment whose service URLs are a PREDICTABLE FORMULA —
 * AWS behind Route53, a k8s cluster, a corp DNS zone, anything not Cloud Run. Pure string
 * substitution, so it is browser-safe and pulls in no cloud SDK.
 *
 * `{svc}` is the service name being resolved; every other `{key}` comes from `vars`:
 *
 * ```ts
 * ClientRegistry.setDeriver(templateDeriver('https://{svc}.example.com'));                       // prod
 * ClientRegistry.setDeriver(templateDeriver('https://{svc}.{env}.example.com', { env: 'qa' }));  // per-env
 * ```
 *
 * Nothing about this is GCP-specific, which is the point: an AWS deployment installs THIS (or no
 * deriver at all, and registers its mappings) and never pulls in gcp-metadata.
 *
 * @throws Error at DERIVE time if the pattern still holds an unsubstituted `{key}` — a typo in the
 *         pattern (or a var you forgot to pass) must not silently ship a bogus hostname.
 */
// webpieces-disable no-function-outside-class -- a deriver IS a function; this is the factory that closes over the pattern (see ServiceUrlDeriver)
export function templateDeriver(pattern: string, vars: Record<string, string> = {}): ServiceUrlDeriver {
    // async, so a bad pattern REJECTS like every other resolution failure rather than throwing
    // synchronously out of ClientRegistry.tryResolve.
    return async (svcName: string): Promise<string> => {
        const substitutions: Record<string, string> = { ...vars, svc: svcName };
        const url = pattern.replace(/\{(\w+)\}/g, (placeholder: string, key: string): string => {
            const value = substitutions[key];
            return value === undefined ? placeholder : value;
        });

        const leftover = /\{(\w+)\}/.exec(url);
        if (leftover) {
            throw new Error(
                `templateDeriver('${pattern}') cannot resolve "${svcName}": no value for {${leftover[1]}}. ` +
                `Pass it in the vars argument, e.g. templateDeriver(pattern, { ${leftover[1]}: '...' }).`,
            );
        }
        return url;
    };
}
