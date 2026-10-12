/**
 * @webpieces/cloudtasks-client
 *
 * Cloud Tasks enqueue client generated from a shared @PubSub API contract — the
 * fire-and-forget twin of @webpieces/http-client. The client and the controller
 * share ONE abstract API class; calling a method enqueues a task that is later
 * delivered to the same endpoint through the full server filter chain.
 */

export { ScheduleInfo, JobReference, TaskRequest, TaskInvoker, EnqueuePlan } from './TaskTypes';
export type { TaskCustomizer, ICreateTaskRequest } from './TaskTypes';
export { TaskName } from './TaskName';
export { TaskAlreadyExistsError } from './TaskAlreadyExistsError';
export { GcpTaskRegistry } from './GcpTaskRegistry';
export { GrpcErrorMapper } from './GrpcErrorMapper';
export { ClientCloudTasksFactory } from './ClientCloudTasksFactory';
export { TaskProxyClient, TASK_PROXY_CLIENT_PROVIDER } from './TaskProxyClient';
export { TaskClientConfig } from './TaskClientConfig';
export type { ApiPrototype } from './TaskClientConfig';
export { CloudTaskScheduler, ScheduleOptions } from './CloudTaskScheduler';
// The two task transports (local HTTP-queue + remote GCP), both delivering over real HTTP.
export { InMemoryTaskInvoker } from './InMemoryTaskInvoker';
export { GcpTaskInvoker } from './GcpTaskInvoker';
// Process-wide CloudTasksClient settings (keepalive, endpoint): override this provider at startup.
export { CloudTasksClientProvider } from './CloudTasksClientProvider';
// NOTE: server-side delivery-auth is enforced by the framework AuthFilter (AuthMode-driven)
// in @webpieces/http-routing — a client library has no server filters / routing machinery.
export {
    ScheduleFrame,
    setScheduleFrame,
    currentScheduleFrame,
    clearScheduleFrame,
} from './ScheduleContext';

