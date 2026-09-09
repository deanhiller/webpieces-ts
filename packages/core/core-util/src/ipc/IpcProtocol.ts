import { ApiErrorPayload, InternalError } from '../errors';
import { IpcIdentity } from './IpcContract';

export class IpcCallContext {
    constructor(
        readonly txId: string,
        readonly callId: string,
        readonly parentCallId?: string,
    ) {
        IpcIdentity.assert(txId, 'transaction');
        IpcIdentity.assert(callId, 'call');
        if (parentCallId !== undefined) IpcIdentity.assert(parentCallId, 'parent call');
    }
}

export class IpcRequest {
    readonly version = 1;
    readonly type = 'request';
    constructor(
        readonly apiId: string,
        readonly methodId: string,
        readonly context: IpcCallContext,
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        readonly body: unknown,
    ) {}
}
export class IpcSuccess {
    readonly version = 1;
    readonly type = 'success';
    constructor(
        readonly context: IpcCallContext,
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        readonly body: unknown,
    ) {}
}
export class IpcFailure {
    readonly version = 1;
    readonly type = 'failure';
    constructor(
        readonly context: IpcCallContext,
        readonly error: ApiErrorPayload,
    ) {}
}
export type IpcReply = IpcSuccess | IpcFailure;
export type IpcMessage = IpcRequest | IpcReply;

export class IpcProtocol {
    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary; webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    static record(value: unknown): Record<string, unknown> {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new InternalError('Malformed IPC envelope');
        }
        // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
        return value as Record<string, unknown>;
    }

    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary
    static parse(json: string): IpcMessage {
        const value = IpcProtocol.record(JSON.parse(json));
        if (value['version'] !== 1) throw new InternalError('Unsupported IPC protocol version');
        const raw = IpcProtocol.record(value['context']);
        const context = new IpcCallContext(
            raw['txId'] as string,
            raw['callId'] as string,
            raw['parentCallId'] as string | undefined,
        );
        switch (value['type']) {
            case 'request':
                IpcIdentity.assert(value['apiId'], 'API');
                IpcIdentity.assert(value['methodId'], 'method');
                if (!Object.prototype.hasOwnProperty.call(value, 'body'))
                    throw new InternalError('Missing IPC request body');
                return new IpcRequest(value['apiId'], value['methodId'], context, value['body']);
            case 'success':
                if (!Object.prototype.hasOwnProperty.call(value, 'body'))
                    throw new InternalError('Missing IPC success body');
                return new IpcSuccess(context, value['body']);
            case 'failure':
                return new IpcFailure(
                    context,
                    // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
                    IpcProtocol.record(value['error']) as unknown as ApiErrorPayload,
                );
            default:
                throw new InternalError('Invalid IPC message discriminator');
        }
    }

    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary
    static sameContext(a: IpcCallContext, b: IpcCallContext): boolean {
        return a.callId === b.callId && a.txId === b.txId && a.parentCallId === b.parentCallId;
    }
}
