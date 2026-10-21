import { ApiCallContext } from '../http/ApiCallContext';
import { LogApiCallImpl } from '../http/LogApiCall';
import { ApiMethodInfo, ApiSide } from '../http/ApiMethodInfo';
import { MaskSpec } from '../http/LogFieldMask';
import { IpcCallContext } from './IpcProtocol';

/** Hosts bind correlation to a per-call logging context; never keep mutable context across awaits. */
export interface IpcLogging {
    context(call: IpcCallContext): ApiCallContext;
}

export class IpcCallLogger {
    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary
    static execute<Q, R>(
        logging: IpcLogging,
        context: IpcCallContext,
        side: ApiSide,
        apiId: string,
        methodId: string,
        mask: MaskSpec,
        request: Q,
        invoke: (request: Q) => Promise<R>,
    ): Promise<R> {
        return new LogApiCallImpl(logging.context(context)).execute(
            new ApiMethodInfo(side, apiId, methodId, undefined, mask),
            request,
            invoke,
        ) as Promise<R>;
    }
}
