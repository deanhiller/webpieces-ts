/**
 * Which IP addresses count as INTERNAL — i.e. reachable only because of where our process happens
 * to sit, and therefore never a legitimate destination for a URL a partner supplied.
 *
 * Pure and dependency-free (it judges an address string, it does not resolve one), so it is unit
 * testable without DNS and is shared by the URL check and the redirect check.
 *
 * The list is deliberately WIDER than "RFC1918". A consumer running on a VPC connector can reach a
 * great deal more than 10/8, and the address that actually gets stolen in practice is
 * `169.254.169.254` — the cloud metadata service, which hands out the runtime service account's
 * tokens to anything that asks.
 */
export class InternalAddressRules {
    /** IPv4 CIDRs that are internal, as [network, prefix length]. */
    private static readonly V4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
        ['0.0.0.0', 8], //        "this network" — 0.x is routed to localhost by some stacks
        ['10.0.0.0', 8], //       RFC1918 private
        ['100.64.0.0', 10], //    RFC6598 carrier-grade NAT — a shared-tenant range, never ours to trust
        ['127.0.0.0', 8], //      loopback
        ['169.254.0.0', 16], //   link-local, and with it 169.254.169.254 CLOUD METADATA
        ['172.16.0.0', 12], //    RFC1918 private
        ['192.0.0.0', 24], //     IETF protocol assignments
        ['192.0.2.0', 24], //     TEST-NET-1
        ['192.168.0.0', 16], //   RFC1918 private
        ['198.18.0.0', 15], //    benchmarking
        ['198.51.100.0', 24], //  TEST-NET-2
        ['203.0.113.0', 24], //   TEST-NET-3
        ['224.0.0.0', 4], //      multicast
        ['240.0.0.0', 4], //      reserved, incl. 255.255.255.255 broadcast
    ];

    /**
     * Hostnames that are internal by NAME, independent of what they resolve to. Checked before DNS
     * because the metadata service answers to its name inside every GCP VM and the name is what
     * appears in a copy-pasted URL.
     */
    private static readonly INTERNAL_HOSTNAMES: ReadonlySet<string> = new Set([
        'localhost',
        'metadata',
        'metadata.google.internal',
        'metadata.goog',
        'instance-data',
    ]);

    /** True when `hostname` is internal by name alone (no DNS needed). */
    isInternalHostname(hostname: string): boolean {
        const lower = hostname.toLowerCase().replace(/\.$/, '');
        if (InternalAddressRules.INTERNAL_HOSTNAMES.has(lower)) {
            return true;
        }
        // Any *.internal / *.localhost name is infrastructure-local by convention.
        return lower.endsWith('.internal') || lower.endsWith('.localhost');
    }

    /**
     * True when `address` is an internal IP. Accepts IPv4 dotted-quad and IPv6 (including the
     * IPv4-mapped `::ffff:a.b.c.d` form, which is how a dual-stack resolver reports an IPv4 answer
     * and therefore the obvious way to smuggle 127.0.0.1 past an IPv4-only check).
     *
     * An address it cannot parse is treated as INTERNAL. Unparseable means "we do not know what this
     * is", and the safe answer to that on the SSRF path is refusal, not delivery.
     */
    isInternalAddress(address: string): boolean {
        const bare = address.replace(/^\[|\]$/g, '').split('%')[0];
        if (bare.includes(':')) {
            return this.isInternalV6(bare);
        }
        return this.isInternalV4(bare);
    }

    private isInternalV4(address: string): boolean {
        const value = this.toV4Number(address);
        if (value === undefined) {
            return true;
        }
        for (const block of InternalAddressRules.V4_BLOCKS) {
            const network = this.toV4Number(block[0]);
            if (network === undefined) {
                continue;
            }
            // A /0 mask would shift by 32, which is a no-op in JS — no block here uses one.
            const mask = (0xffffffff << (32 - block[1])) >>> 0;
            if ((value & mask) >>> 0 === (network & mask) >>> 0) {
                return true;
            }
        }
        return false;
    }

    private isInternalV6(address: string): boolean {
        const lower = address.toLowerCase();
        // A dual-stack resolver reports IPv4 as ::ffff:a.b.c.d — judge it as the IPv4 it is.
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
        if (mapped) {
            return this.isInternalV4(mapped[1]);
        }
        // …and the URL parser NORMALIZES that same address to its hex form, `::ffff:7f00:1`. Both
        // spellings name 127.0.0.1, so both have to be judged as it — checking only the dotted form
        // would let `https://[::ffff:127.0.0.1]` through the moment it went through `new URL()`.
        const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
        if (mappedHex) {
            const high = parseInt(mappedHex[1], 16);
            const low = parseInt(mappedHex[2], 16);
            const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
            return this.isInternalV4(dotted);
        }
        if (lower === '::1' || lower === '::') {
            return true;
        }
        // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
        return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
    }

    /** The dotted quad as a 32-bit number, or undefined when it is not a dotted quad at all. */
    private toV4Number(address: string): number | undefined {
        const parts = address.split('.');
        if (parts.length !== 4) {
            return undefined;
        }
        let value = 0;
        for (const part of parts) {
            if (!/^\d{1,3}$/.test(part)) {
                return undefined;
            }
            const octet = Number(part);
            if (octet > 255) {
                return undefined;
            }
            value = (value * 256 + octet) >>> 0;
        }
        return value;
    }
}
