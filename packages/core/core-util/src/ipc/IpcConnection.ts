import { toError } from '../lib/errorUtils';
import { TimeoutError } from '../http/TimeoutError';
import { CallContext } from '../http/CallStrategy';
import { ApiErrorCodec, EndpointNotFoundError, InternalError } from '../errors';
import {
    IpcCallContext,
    IpcFailure,
    IpcMessage,
    IpcReply,
    IpcRequest,
    IpcProtocol,
} from './IpcProtocol';

/** A local connection failed, distinct from a remote implementation's semantic ApiError. */
export class IpcTransportError extends Error {
    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = 'IpcTransportError';
    }
}

/** Implement this at the host transport boundary; no vendor or platform declarations leak out. */
export interface IpcTransport {
    send(message: string): Promise<void> | void;
    subscribe(
        receive: (message: string) => void,
        failed: (error: Error) => void,
        closed: (error: Error) => void,
    ): () => void;
    close(): void;
}
export interface IpcScheduler {
    schedule(callback: () => void, delayMs: number): () => void;
}
export interface IpcErrorOwner {
    report(error: Error): void;
}
export class IpcConnectionOptions {
    constructor(
        readonly timeoutMs: number,
        readonly nextId: () => string,
        readonly scheduler: IpcScheduler,
        readonly errors: IpcErrorOwner,
        readonly maxMessageCharacters = 1_000_000,
    ) {
        if (
            !Number.isFinite(timeoutMs) ||
            timeoutMs <= 0 ||
            !Number.isSafeInteger(maxMessageCharacters) ||
            maxMessageCharacters < 1
        ) {
            throw new InternalError('IPC timeout and message limit must be positive');
        }
    }
}

class PendingCall {
    cancelTimer: () => void = () => {};
    constructor(
        readonly context: IpcCallContext,
        readonly resolve: (reply: IpcReply) => void,
        readonly reject: (error: Error) => void,
    ) {}
}

/** One connection owns both directions, one dispatcher, and all pending-call lifetimes. */
export class IpcConnection {
    private readonly pending = new Map<string, PendingCall>();
    private readonly activeRequests = new Set<string>();
    private readonly usedIds = new Set<string>();
    private handler?: (request: IpcRequest) => Promise<IpcReply>;
    private closed?: Error;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly transport: IpcTransport,
        private readonly options: IpcConnectionOptions,
    ) {
        this.unsubscribe = transport.subscribe(
            (message) => this.receive(message),
            (error) => this.fail(new IpcTransportError('IPC transport failed', error)),
            (error) => this.fail(new IpcTransportError('IPC connection closed', error)),
        );
    }

    /** Install exactly one factory dispatcher BEFORE exposing this connection to the peer. */
    setHandler(handler: (request: IpcRequest) => Promise<IpcReply>): void {
        if (this.handler) throw new InternalError('An IPC connection already has a dispatcher');
        if (this.closed) throw this.closed;
        this.handler = handler;
    }

    newContext(parent?: IpcCallContext): IpcCallContext {
        const id = this.options.nextId();
        if (this.usedIds.has(id))
            throw new InternalError('IPC identity generator reused a call ID');
        this.usedIds.add(id);
        return new IpcCallContext(parent?.txId ?? id, id, parent?.callId);
    }

    request(request: IpcRequest): Promise<IpcReply> {
        if (this.closed) return Promise.reject(this.closed);
        if (this.pending.has(request.context.callId))
            return Promise.reject(new InternalError('Duplicate pending IPC call'));
        return new Promise<IpcReply>((resolve, reject) => {
            const pending = new PendingCall(request.context, resolve, reject);
            this.pending.set(request.context.callId, pending);
            pending.cancelTimer = this.options.scheduler.schedule(() => {
                this.settle(
                    request.context.callId,
                    new TimeoutError(
                        this.options.timeoutMs,
                        new CallContext(request.apiId, request.methodId),
                    ),
                );
            }, this.options.timeoutMs);
            // This owner observes every async send rejection; a send failure is never a timeout.
            void this.send(request).catch((error) => {
                this.settle(
                    request.context.callId,
                    new IpcTransportError('IPC send failed', IpcErrors.normalize(error)),
                );
            });
        });
    }

    dispose(): void {
        this.fail(new IpcTransportError('IPC connection disposed'));
        this.unsubscribe();
        this.transport.close();
    }

    private async send(message: IpcMessage): Promise<void> {
        if (this.closed) throw this.closed;
        const json = JSON.stringify(message);
        if (json.length > this.options.maxMessageCharacters)
            throw new InternalError('IPC message exceeds configured limit');
        await this.transport.send(json);
    }

    private receive(json: string): void {
        if (this.closed) return;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- transport boundary rejects pending calls or encodes a failure that the client throws
        try {
            if (json.length > this.options.maxMessageCharacters)
                throw new InternalError('IPC message exceeds configured limit');
            const message = IpcProtocol.parse(json);
            if (message.type === 'request') {
                if (this.activeRequests.has(message.context.callId))
                    throw new InternalError('Duplicate active IPC request');
                this.activeRequests.add(message.context.callId);
                void this.dispatch(message).catch((error) => this.fail(IpcErrors.normalize(error)));
                return;
            }
            const pending = this.pending.get(message.context.callId);
            // Late or unsolicited replies are reported, never resolve a different call or replay work.
            if (!pending) {
                this.options.errors.report(new InternalError('Late or unknown IPC reply'));
                return;
            }
            if (!IpcProtocol.sameContext(pending.context, message.context))
                throw new InternalError('IPC reply correlation mismatch');
            this.pending.delete(message.context.callId);
            pending.cancelTimer();
            pending.resolve(message);
        } catch (err: unknown) {
            const error = toError(err);
            this.fail(IpcErrors.normalize(error));
        }
    }

    private async dispatch(request: IpcRequest): Promise<void> {
        let reply: IpcReply;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- transport boundary rejects pending calls or encodes a failure that the client throws
        try {
            if (!this.handler) throw new EndpointNotFoundError('IPC dispatcher is not installed');
            reply = await this.handler(request);
            if (!IpcProtocol.sameContext(request.context, reply.context))
                throw new InternalError('IPC handler reply correlation mismatch');
        } catch (err: unknown) {
            const error = toError(err);
            reply = new IpcFailure(request.context, ApiErrorCodec.encode(error));
        } finally {
            this.activeRequests.delete(request.context.callId);
        }
        await this.send(reply);
    }

    private settle(id: string, error: Error): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cancelTimer();
        pending.reject(error);
    }

    private fail(error: Error): void {
        if (this.closed) return;
        this.closed = error;
        for (const id of this.pending.keys()) this.settle(id, error);
        this.options.errors.report(error);
    }
}

export class IpcErrors {
    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary; webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    static normalize(value: unknown): Error {
        return value instanceof Error
            ? value
            : new InternalError('IPC failed with a non-Error value');
    }
}
