import { CloudTasksClient } from '@google-cloud/tasks';
import { provideFrameworkSingleton } from '@webpieces/core-context';

/**
 * Builds the ONE `CloudTasksClient` that `GcpTaskInvoker` enqueues through — the place for
 * process-wide CLIENT settings: the gRPC channel (keepalive), the endpoint, `clientConfig`.
 *
 * The default builds `new CloudTasksClient()`, exactly what `GcpTaskInvoker` always did, so nobody has
 * to bind anything. An app that needs client-level settings overrides it at startup:
 *
 * ```ts
 * class KeepaliveCloudTasks extends CloudTasksClientProvider {
 *     override create(): CloudTasksClient {
 *         return new CloudTasksClient({ 'grpc.keepalive_time_ms': 30_000 });
 *     }
 * }
 * (await options.rebind(CloudTasksClientProvider)).to(KeepaliveCloudTasks).inSingletonScope();
 * ```
 *
 * Why a provider class and not an optional `CloudTasksClient` binding: the app container is created
 * with inversify `autobind`, which auto-constructs ANY unbound class token — `@optional()` included —
 * and `CloudTasksClient` has no injectable metadata, so resolving it unbound throws
 * ("CloudTasksClient constructor requires at least 2 arguments"). A provider that is always bound
 * keeps the same contract — optional to override, today's client by default — with nothing to throw.
 *
 * Per-CALL settings are not here: gax `CallOptions` belong on `ScheduleOptions.gax` /
 * `GcpTaskRegistry.setGax`, and the Google request on a `TaskCustomizer`.
 */
@provideFrameworkSingleton()
export class CloudTasksClientProvider {
    create(): CloudTasksClient {
        return new CloudTasksClient();
    }
}
