import 'reflect-metadata';
import { ApiConnectionError } from '../errors/ApiError';
import { ApiErrorCodec, ApiErrorPayload } from '../errors/ApiErrorCodec';
import { ApiJsonSchema, ApiJsonSchemaValidator, DtoValue } from '../mcp/DtoSchema';
import { toError } from '../lib/errorUtils';
import { METADATA_KEYS } from './decorators';

/** Stable application-level key for relating stream events and failures. */
export class StreamCorrelation {
    constructor(
        public readonly key: string | number,
        public readonly requestId?: string,
    ) {}
}

export interface StreamFailureOptions {
    /** Defaults to true. Wire adapters may promote false to true when continuation is unsafe. */
    terminal?: boolean;
}

/** Server-to-client half of a typed stream. Every write is an explicit backpressure boundary. */
export interface ResponseStream<T> {
    event(value: T, correlation?: StreamCorrelation): Promise<void>;
    /**
     * Publish a failure on this stream. Takes `Error`, the parent of everything: `ApiError` is a
     * CONVENIENCE taxonomy webpieces ships so the common cases are easy, never something the
     * framework may demand from an application. An app's own `MyLibError extends Error` is
     * published as kind `implementation` with generic text, exactly as on every other boundary.
     *
     * This is the FAITHFUL {@link ApiErrorCodec} encode, NOT `ApiErrorBoundary.encode`, and that is
     * deliberate: a stream failure is delivered IN BAND to a peer that is reading the stream, so a
     * {@link StreamTransportError} (an `ApiConnectionError`) must arrive as kind `connection` for
     * the peer to reconstruct it as the transport failure it is. Republishing it as
     * `implementation` — right at an HTTP/MCP edge, where the caller is asking us to do work — would
     * tell the peer the wrong thing about a stream it is holding one end of.
     */
    fail(
        error: Error,
        correlation?: StreamCorrelation,
        options?: StreamFailureOptions,
    ): Promise<void>;
    complete(): Promise<void>;
    // webpieces-disable no-any-unknown -- cancellation reasons are deliberately transport-neutral
    onCancel(handler: (reason?: unknown) => void | Promise<void>): void;
}

/** Client-to-server half. Cancellation exists immediately and is independent of writer readiness. */
export interface RequestStream<T> {
    event(value: T, correlation?: StreamCorrelation): Promise<void>;
    /**
     * Publish a failure on this stream. Takes `Error`, the parent of everything: `ApiError` is a
     * CONVENIENCE taxonomy webpieces ships so the common cases are easy, never something the
     * framework may demand from an application. An app's own `MyLibError extends Error` is
     * published as kind `implementation` with generic text, exactly as on every other boundary.
     *
     * This is the FAITHFUL {@link ApiErrorCodec} encode, NOT `ApiErrorBoundary.encode`, and that is
     * deliberate: a stream failure is delivered IN BAND to a peer that is reading the stream, so a
     * {@link StreamTransportError} (an `ApiConnectionError`) must arrive as kind `connection` for
     * the peer to reconstruct it as the transport failure it is. Republishing it as
     * `implementation` — right at an HTTP/MCP edge, where the caller is asking us to do work — would
     * tell the peer the wrong thing about a stream it is holding one end of.
     */
    fail(
        error: Error,
        correlation?: StreamCorrelation,
        options?: StreamFailureOptions,
    ): Promise<void>;
    complete(): Promise<void>;
    // webpieces-disable no-any-unknown -- cancellation reasons are deliberately transport-neutral
    cancel(reason?: unknown): Promise<void>;
}

export type StreamEnvelopeKind = 'event' | 'failure' | 'complete';

/** Transport-neutral record used by NDJSON and SSE adapters. */
export class StreamEnvelope<T = DtoValue> {
    constructor(
        public readonly kind: StreamEnvelopeKind,
        public readonly value?: T,
        public readonly error?: ApiErrorPayload,
        public readonly correlation?: StreamCorrelation,
        public readonly terminal?: boolean,
    ) {}
}

/** Local failure where no legal in-band envelope could be sent or decoded. */
export class StreamTransportError extends ApiConnectionError {
    constructor(
        message: string,
        public readonly correlation?: StreamCorrelation,
        public readonly requestId?: string,
        cause?: Error,
    ) {
        super(message, cause);
    }
}

/**
 * Runtime schema and wire-policy metadata for one streaming method.
 *
 * It holds the two event SCHEMAS rather than two DTO classes. Until #984 it held classes and built
 * their schemas from `@WpDtoField` at decoration time; that decorator is deleted, because the
 * compiler already knows every fact it restated (#983). A schema is the thing a boundary validates
 * against, so it is the thing the metadata carries.
 */
export class StreamingEndpointMetadata {
    constructor(
        public readonly requestSchema: ApiJsonSchema,
        public readonly responseSchema: ApiJsonSchema,
        /** Generic NDJSON/SSE supports non-terminal failures in both directions. */
        public readonly supportsNonTerminalFailures = true,
    ) {}
}

/**
 * Marks `(ResponseStream<ResponseEvent>) => Promise<RequestStream<RequestEvent>>`, with the two
 * event schemas the wire adapters validate against.
 *
 * Build them with {@link ObjectSchemaBuilder}, or read them out of the build's generated model.
 */
// webpieces-disable no-function-outside-class -- decorator factory
export function WpStream(
    requestEventSchema: ApiJsonSchema,
    responseEventSchema: ApiJsonSchema,
): MethodDecorator {
    return (target: object, propertyKey: string | symbol): void => {
        const apiClass = target.constructor;
        const methods: Record<string, StreamingEndpointMetadata> =
            Reflect.getMetadata(METADATA_KEYS.STREAM_ENDPOINTS, apiClass) ?? {};
        methods[String(propertyKey)] = new StreamingEndpointMetadata(
            requestEventSchema,
            responseEventSchema,
        );
        Reflect.defineMetadata(METADATA_KEYS.STREAM_ENDPOINTS, methods, apiClass);
    };
}

// webpieces-disable no-function-outside-class -- metadata reader paired with WpStream
export function getStreamingEndpoint(
    apiClass: Function,
    methodName: string,
): StreamingEndpointMetadata | undefined {
    const methods: Record<string, StreamingEndpointMetadata> =
        Reflect.getMetadata(METADATA_KEYS.STREAM_ENDPOINTS, apiClass) ?? {};
    return methods[methodName];
}

/** Validate a typed event at every adapter boundary, with one consistent diagnostic. */
export class StreamEventValidator {
    private readonly schemas = new ApiJsonSchemaValidator();

    // webpieces-disable no-any-unknown -- DTO validation is the runtime narrowing boundary
    validate(schema: ApiJsonSchema, value: unknown, direction: 'request' | 'response'): void {
        const failure = this.schemas.validate(schema, value as DtoValue);
        if (failure)
            throw new StreamTransportError(`Invalid ${direction} stream event: ${failure.message}`);
    }
}

/** Awaiting the sink acknowledges the write, so adapters cannot outrun their consumer. */
export class StreamWriter<T> implements RequestStream<T>, ResponseStream<T> {
    private terminal = false;
    private cancelled = false;
    private pending: Promise<void> = Promise.resolve();
    // webpieces-disable no-any-unknown -- cancellation reasons are deliberately transport-neutral
    private readonly cancelHandlers: Array<(reason?: unknown) => void | Promise<void>> = [];

    constructor(
        private readonly sink: (envelope: StreamEnvelope<T>) => Promise<void>,
        private readonly validateEvent?: (value: T) => void,
        private readonly allowNonTerminalFailures = true,
    ) {}

    async event(value: T, correlation?: StreamCorrelation): Promise<void> {
        this.requireWritable();
        this.validateEvent?.(value);
        await this.enqueue(new StreamEnvelope('event', value, undefined, correlation));
    }

    async fail(
        error: Error,
        correlation?: StreamCorrelation,
        options?: StreamFailureOptions,
    ): Promise<void> {
        this.requireWritable();
        const terminal = (options?.terminal ?? true) || !this.allowNonTerminalFailures;
        if (terminal) this.terminal = true;
        await this.enqueue(
            new StreamEnvelope<T>(
                'failure',
                undefined,
                ApiErrorCodec.encode(error),
                correlation,
                terminal,
            ),
        );
    }

    async complete(): Promise<void> {
        this.requireWritable();
        this.terminal = true;
        await this.enqueue(new StreamEnvelope<T>('complete'));
    }

    // webpieces-disable no-any-unknown -- cancellation reasons are deliberately transport-neutral
    onCancel(handler: (reason?: unknown) => void | Promise<void>): void {
        this.cancelHandlers.push(handler);
    }

    // webpieces-disable no-any-unknown -- cancellation reasons are deliberately transport-neutral
    async cancel(reason?: unknown): Promise<void> {
        if (this.cancelled || this.terminal) return;
        this.cancelled = true;
        this.terminal = true;
        for (const handler of this.cancelHandlers) await handler(reason);
    }

    private requireWritable(): void {
        if (this.terminal || this.cancelled)
            throw new StreamTransportError('Cannot write after stream termination.');
    }

    private enqueue(envelope: StreamEnvelope<T>): Promise<void> {
        const delivery = this.pending.then(async () => this.sink(envelope));
        this.pending = delivery.catch(() => undefined);
        // webpieces-disable no-any-unknown -- transport boundary normalizes arbitrary sink failures
        return delivery.catch((err: unknown) => {
            this.terminal = true;
            const error = toError(err);
            if (error instanceof StreamTransportError) throw error;
            throw new StreamTransportError(
                'Stream transport could not acknowledge a write.',
                envelope.correlation,
                envelope.correlation?.requestId,
                error,
            );
        });
    }
}
