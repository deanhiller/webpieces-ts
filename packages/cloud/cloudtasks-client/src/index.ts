/**
 * @webpieces/cloudtasks-client
 *
 * Cloud Tasks enqueue client generated from a shared @PubSub API contract — the
 * fire-and-forget twin of @webpieces/http-client. The client and the controller
 * share ONE abstract API class; calling a method enqueues a task that is later
 * delivered to the same endpoint through the full server filter chain.
 */

export {
    ScheduleInfo,
    JobReference,
    TaskRequest,
    TaskInvoker,
} from './TaskTypes';
export { ClientCloudTasksFactory } from './ClientCloudTasksFactory';
export { TaskProxyClient } from './TaskProxyClient';
export { TaskClientConfig } from './TaskClientConfig';
export type { ApiPrototype } from './TaskClientConfig';
export { CloudTaskScheduler, ScheduleOptions } from './CloudTaskScheduler';
// The two task transports (local HTTP-queue + remote GCP), both delivering over real HTTP.
export { InMemoryTaskInvoker } from './InMemoryTaskInvoker';
export { GcpTaskInvoker } from './GcpTaskInvoker';
// NOTE: server-side delivery-auth is enforced by the framework AuthFilter (AuthMode-driven)
// in @webpieces/http-routing — a client library has no server filters / routing machinery.
export {
    ScheduleFrame,
    setScheduleFrame,
    currentScheduleFrame,
    clearScheduleFrame,
} from './ScheduleContext';
