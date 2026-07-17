import { format } from 'winston';
import { WinstonFactoryBase } from './WinstonFactoryBase';
import { ChunkingConsoleTransport } from './ChunkingConsoleTransport';
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
 *
 * Writes through a {@link ChunkingConsoleTransport} rather than a plain Console, because THIS is the
 * backend with a size limit: Cloud Logging caps a LogEntry at 256 KiB and — critically — an
 * oversized jsonPayload entry is DROPPED, not truncated, with no error raised anywhere. A big
 * response body or stack trace would simply never appear. The transport splits such a record into
 * several complete, parseable records sharing a `jsonPayload.logChunk.uid`.
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
            new ChunkingConsoleTransport(),
        );
    }
}
