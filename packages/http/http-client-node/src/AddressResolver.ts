import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { provideFrameworkSingleton } from '@webpieces/core-context';

/**
 * Turns a hostname into the IP addresses it actually resolves to — the half of the SSRF check that
 * has to touch the network, kept behind its own class so the policy itself is unit-testable without
 * DNS and a test can hand the guard a resolver that answers whatever the case needs.
 *
 * ABSTRACT rather than an interface because it is a collaborator with behavior, and because
 * @webpieces/core-mock and app tests substitute it by TYPE.
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

/** The real one: node's DNS resolver, asking for every address family. */
@provideFrameworkSingleton()
export class DnsAddressResolver extends AddressResolver {
    override async resolve(hostname: string): Promise<string[]> {
        const answers: LookupAddress[] = await lookup(hostname, { all: true, verbatim: true });
        return answers.map((answer: LookupAddress) => answer.address);
    }
}
