import { injectable } from 'inversify';
import { Secrets } from '@webpieces/core-util';

/**
 * EnvironmentSecrets - the ONE shared-secret store for this service's outbound clients, bound to
 * SECRETS as a singleton in src/wiring.ts and read from env once. Copied into legacy-server so it
 * does not depend on the greenfield app.
 */
@injectable()
export class EnvironmentSecrets extends Secrets {
    constructor() {
        super({ INTERNAL_API_SECRET: process.env['INTERNAL_API_SECRET'] });
    }
}
