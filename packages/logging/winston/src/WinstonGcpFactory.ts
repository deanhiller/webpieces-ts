import { format } from 'winston';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { bigIntSafeFormat, injectContextFormat, severityFormat } from './format';

/**
 * WinstonGcpFactory - the GCP/Cloud Run backend. Emits flat JSON to stdout; the
 * Cloud Run / GKE logging agent natively parses it — `severity` + `message` lift
 * onto the LogEntry and every registered context key lands at top-level
 * jsonPayload.<name> (requestId, tenantId, …), filterable directly. There is NO
 * @google-cloud transport — correlation rides the webpieces context, read
 * DIRECTLY from RequestContext on each line. This matches the tested-in-GCP
 * onetablet/monorepo-nx1 core logger exactly.
 *
 * The service name + version come from {@link ServiceInfo}, which startup must have populated
 * (this constructor reads them); they are NOT factory options.
 */
export class WinstonGcpFactory extends WinstonFactoryBase {
    constructor() {
        super(
            format.combine(
                bigIntSafeFormat(),
                injectContextFormat(),
                severityFormat(),
                format.json(),
            ),
        );
    }
}
