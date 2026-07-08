import { format } from 'winston';
import type { ContextReader } from '@webpieces/core-util';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { WinstonFactoryOptions } from './WinstonFactoryOptions';
import { bigIntSafeFormat, injectContextFormat, severityFormat } from './format';

/**
 * WinstonGcpFactory - the GCP/Cloud Run backend. Emits flat JSON to stdout; the
 * Cloud Run / GKE logging agent natively parses it — `severity` + `message` lift
 * onto the LogEntry and every registered context key lands at top-level
 * jsonPayload.<name> (requestId, tenantId, …), filterable directly. There is NO
 * @google-cloud transport — correlation rides the webpieces context. This matches
 * the tested-in-GCP onetablet/monorepo-nx1 core logger exactly.
 *
 * @param reader the environment's ContextReader — on a node server pass
 *   `new RequestContextReader()` from @webpieces/core-context. Keeping it a
 *   constructor arg is why this package depends only on @webpieces/core-util.
 */
export class WinstonGcpFactory extends WinstonFactoryBase {
    constructor(reader: ContextReader, opts: WinstonFactoryOptions = new WinstonFactoryOptions()) {
        super(
            format.combine(
                bigIntSafeFormat(),
                injectContextFormat(reader),
                severityFormat(),
                format.json(),
            ),
            opts,
        );
    }
}
