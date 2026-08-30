import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { provideFrameworkSingletonDefaultForApi } from '@webpieces/core-context';

/**
 * Turns a hostname into the IP addresses it actually resolves to — the half of the SSRF check that
 * has to touch the network, kept behind its own class so the policy itself is unit-testable without
 * DNS and a test can hand the guard a resolver that answers whatever the case needs.
 *
 * ABSTRACT rather than an interface because it is a collaborator with behavior, and because
 * @webpieces/core-mock and app tests substitute it by TYPE.
 *
 * DI-BOUND, not threaded through constructors: {@link DnsAddressResolver} registers itself as the
 * DEFAULT for this base, so every `NodeProxyClient` gets a working resolver with nobody writing a
 * line, and an app or a test rebinds THIS type to substitute one. Passing a resolver in at each
 * client construction site — which is what the deleted host-policy classes did — made the framework's
 * own dependency the app's to remember, on every single client, forever.
 */
export abstract class AddressResolver {
    /**
     * Every address `hostname` resolves to, as strings. ALL of them matter: a hostname that answers
     * with one public address and one 127.0.0.1 is the classic DNS-rebinding shape, and a guard that
     * checks only the first answer waves it through.
     *
     * @throws Error when the name does not resolve. The guard treats that as a refusal, not as a
     *         pass — a destination we cannot even name is not one we should POST a payload to.
     */
    abstract resolve(hostname: string): Promise<string[]>;
}

/**
 * The real one: node's DNS resolver, asking for every address family. Registered as the OVERRIDABLE
 * default for {@link AddressResolver}, so injecting the base type just works and a test rebinding
 * that type wins.
 */
@provideFrameworkSingletonDefaultForApi(AddressResolver)
export class DnsAddressResolver extends AddressResolver {
    override async resolve(hostname: string): Promise<string[]> {
        const answers: LookupAddress[] = await lookup(hostname, { all: true, verbatim: true });
        return answers.map((answer: LookupAddress) => answer.address);
    }
}
