import { ContractIdentity, ImplementsFacts, UsesFacts, WiringRelationship } from './declaration';

/** Compiled with the published tooling; invalid typed relationships cannot enter assembly. */
export class DeclarationCompileAssertions {
    check(): void {
        const identity = new ContractIdentity('api', 'ExampleApi');
        new WiringRelationship(
            identity,
            new UsesFacts('rpc', { kind: 'service', service: 'server' }),
        );
        new WiringRelationship(identity, new ImplementsFacts('rpc'));
        // @ts-expect-error A uses relationship requires an explicit target.
        new UsesFacts('rpc');
        // @ts-expect-error An implementation must not carry a client target.
        new ImplementsFacts('rpc', { kind: 'service', service: 'server' });
        // @ts-expect-error The relationship discriminator cannot bypass the target requirement.
        new WiringRelationship(identity, { direction: 'uses', transport: 'rpc' });
        const implementationWithTarget = {
            direction: 'implements' as const,
            transport: 'rpc' as const,
            target: { kind: 'service' as const, service: 'server' },
        };
        // @ts-expect-error Structural implementation values cannot carry client targets.
        new WiringRelationship(identity, implementationWithTarget);
    }
}
