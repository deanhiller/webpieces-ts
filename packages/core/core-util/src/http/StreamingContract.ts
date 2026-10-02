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

/** Server-to-client half of a typed stream. Every write is an explicit backpressure boundary. */
export enum StreamDirection {
    RESPONSE = 'response',
    REQUEST = 'request',
    FULL = 'full',
}

export interface ResponseStream<T> {
    event(value: T, correlation?: StreamCorrelation): Promise<void>;
    /** Graceful directional EOF after all queued records are acknowledged. */
    close(): Promise<void>;
    /** Abnormal terminal cancellation of the logical exchange. */
    cancel(error?: Error): Promise<void>;
}

/** Client-to-server half. Cancellation exists immediately and is independent of writer readiness. */
export interface RequestStream<TInitialResponse, T> {
    /** The typed opening acknowledgement received before later request events are writable. */
    getInitialResponse(): TInitialResponse;
    event(value: T, correlation?: StreamCorrelation): Promise<void>;
    close(): Promise<void>;
    cancel(error?: Error): Promise<void>;
}

export type StreamEnvelopeKind = 'event' | 'failure' | 'complete';

/** Internal acknowledgement records; these are never serialized around application JSONL DTOs. */
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
 * The build-time API model derives initial and event schemas independently from the signature.
 */
export class StreamingEndpointMetadata {
    constructor(
        public readonly direction: StreamDirection,
        public readonly initialRequestSchema?: ApiJsonSchema,
        public readonly initialResponseSchema?: ApiJsonSchema,
        public readonly requestSchema?: ApiJsonSchema,
        public readonly responseSchema?: ApiJsonSchema,
    ) {}
}

/**
 * Declares direction; the method signature owns all four DTO types. Install its generated
 * stream-Contract-schemas.json with registerStreamingCatalog before binding the contract.
 */
// webpieces-disable no-function-outside-class -- decorator factory is the public annotation API
export function WpStream(direction: StreamDirection): MethodDecorator {
    return (target: object, propertyKey: string | symbol): void => {
        const apiClass = target.constructor;
        const methods: Record<string, StreamingEndpointMetadata> =
            Reflect.getMetadata(METADATA_KEYS.STREAM_ENDPOINTS, apiClass) ?? {};
        methods[String(propertyKey)] = new StreamingEndpointMetadata(direction);
        Reflect.defineMetadata(METADATA_KEYS.STREAM_ENDPOINTS, methods, apiClass);
    };
}

/**
 * Installs the schemas emitted by the build-time API model. Kept separate from `@WpStream` so the
 * contract declaration has one source of truth: its TypeScript signature.
 */
// webpieces-disable no-function-outside-class -- generated wiring calls this metadata registration boundary
export function registerStreamingSchemas(
    apiClass: Function,
    methodName: string,
    schemas: Pick<
        StreamingEndpointMetadata,
        'initialRequestSchema' | 'initialResponseSchema' | 'requestSchema' | 'responseSchema'
    >,
): void {
    const current = getStreamingEndpoint(apiClass, methodName);
    if (!current)
        throw new Error(`${apiClass.name}.${methodName} is not decorated with @WpStream.`);
    const methods: Record<string, StreamingEndpointMetadata> =
        Reflect.getMetadata(METADATA_KEYS.STREAM_ENDPOINTS, apiClass) ?? {};
    methods[methodName] = new StreamingEndpointMetadata(
        current.direction,
        schemas.initialRequestSchema,
        schemas.initialResponseSchema,
        schemas.requestSchema,
        schemas.responseSchema,
    );
    Reflect.defineMetadata(METADATA_KEYS.STREAM_ENDPOINTS, methods, apiClass);
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
export class StreamWriter<T, TInitialResponse = T> implements ResponseStream<T> {
    private terminal = false;
    private cancelled = false;
    private failure?: Error;
    private pending: Promise<void> = Promise.resolve();

    constructor(
        private readonly sink: (envelope: StreamEnvelope<T>) => Promise<void>,
        private readonly validateEvent?: (value: T) => void,
        private readonly initialResponse?: TInitialResponse,
        private readonly cancelSink?: (error?: Error) => Promise<void>,
    ) {}

    getInitialResponse(): TInitialResponse {
        if (this.initialResponse === undefined) {
            throw new StreamTransportError('RequestStream initial response is unavailable.');
        }
        return this.initialResponse;
    }

    async event(value: T, correlation?: StreamCorrelation): Promise<void> {
        this.requireWritable();
        this.validateEvent?.(value);
        await this.enqueue(new StreamEnvelope('event', value, undefined, correlation));
    }

    async close(): Promise<void> {
        this.requireWritable();
        this.terminal = true;
        await this.enqueue(new StreamEnvelope<T>('complete'));
    }

    async cancel(error?: Error): Promise<void> {
        if (this.cancelled) return;
        this.cancelled = true;
        this.failure = error;
        this.terminal = true;
        if (this.cancelSink) {
            await this.cancelSink(error);
            return;
        }
        if (error) {
            await this.enqueue(
                new StreamEnvelope<T>(
                    'failure',
                    undefined,
                    ApiErrorCodec.encode(error),
                    undefined,
                    true,
                ),
            );
        }
    }

    private requireWritable(): void {
        if (this.failure) throw this.failure;
        if (this.terminal) throw new StreamTransportError('Cannot write after stream termination.');
    }

    private enqueue(envelope: StreamEnvelope<T>): Promise<void> {
        const delivery = this.pending.then(async () => {
            if (this.failure && envelope.kind !== 'failure') throw this.failure;
            await this.sink(envelope);
        });
        this.pending = delivery.catch(() => undefined);
        // webpieces-disable no-any-unknown -- transport boundary normalizes arbitrary sink failures
        return delivery.catch((err: unknown) => {
            this.terminal = true;
            const error = toError(err);
            this.failure = error;
            if (this.cancelSink) {
                return this.cancel(error).then((): never => {
                    throw error;
                });
            }
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
