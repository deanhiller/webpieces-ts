import type { ContextReader } from '@webpieces/core-util';
import { BunyanFactoryBase } from './BunyanFactoryBase';
import { BunyanFactoryOptions } from './BunyanFactoryOptions';
import { createGoogleCloudStream } from './streams';

/**
 * BunyanGcpFactory - the GCP backend. Streams to Cloud Logging via
 * @google-cloud/logging-bunyan (which owns the numeric-level→severity mapping,
 * msg→message, trace/httpRequest fields). Registered context keys ride along as
 * structured payload fields. This matches the tested-in-GCP trytami service
 * exactly. Requires GCP Application Default Credentials on the instance.
 *
 * @param reader the environment's ContextReader — on a node server pass
 *   `new RequestContextReader()` from @webpieces/core-context. Keeping it a
 *   constructor arg is why this package depends only on @webpieces/core-util.
 */
export class BunyanGcpFactory extends BunyanFactoryBase {
    constructor(reader: ContextReader, opts: BunyanFactoryOptions = new BunyanFactoryOptions()) {
        super(reader, opts.serviceName, [createGoogleCloudStream(opts.level)]);
    }
}
