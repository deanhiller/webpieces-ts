import { injectable } from 'inversify';
import { Secrets } from '@webpieces/core-util';

/**
 * EnvironmentSecrets - the ONE shared-secret store for ALL of this service's outbound clients
 * (RPC + Cloud Tasks), bound to SECRETS as a singleton in src/wiring.ts. The VALUE it sends per
 * sharedSecret(key) is read from env ONCE, never in the send path (so tests stay parallel-safe).
 * Rotate a client by changing its value here.
 */
@injectable()
export class EnvironmentSecrets extends Secrets {
    constructor() {
        super({ INTERNAL_API_SECRET: process.env['INTERNAL_API_SECRET'] });
    }
}
