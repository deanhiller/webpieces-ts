import { BunyanFactoryBase } from './BunyanFactoryBase';
import { createGoogleCloudStream } from './streams';

/**
 * BunyanGcpFactory - the GCP backend. Streams to Cloud Logging via
 * @google-cloud/logging-bunyan (which owns the numeric-level→severity mapping,
 * msg→message, trace/httpRequest fields). The logged context keys ride along as
 * structured payload fields, read straight from RequestContext on each line. This
 * matches the tested-in-GCP trytami service exactly. Requires GCP Application
 * Default Credentials on the instance.
 *
 * The service name + version come from {@link ServiceInfo}, which startup must have populated
 * BEFORE constructing this.
 */
export class BunyanGcpFactory extends BunyanFactoryBase {
    constructor() {
        super([createGoogleCloudStream()]);
    }
}
