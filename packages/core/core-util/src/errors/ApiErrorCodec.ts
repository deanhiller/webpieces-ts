import {
    ApiError,
    BadRequestError,
    UserError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    EndpointNotFoundError,
    RequestTimeoutError,
    TooManyRequestsError,
    InternalError,
    BadGatewayError,
    ServiceUnavailableError,
    GatewayTimeoutError,
    VendorError,
    OfflineError,
} from './ApiError';

/** Allowlisted error envelope shared by non-HTTP transports. Contains only bounded semantic causes, never stacks or arbitrary properties. */
export class ApiErrorPayload {
    public cause?: ApiErrorPayload;
    public subType?: string;
    public field?: string;
    public guiAlertMessage?: string;
    public errorCode?: string;
    public waitSeconds?: number;
    constructor(
        public kind: string,
        public message: string,
    ) {}
}

/** Bounded, safe, transport-neutral encoding. Unrecognized types become generic internal failures. */
export class ApiErrorCodec {
    // webpieces-disable no-function-outside-class -- stateless public codec shared by transport adapters; webpieces-disable no-any-unknown -- thrown values are untrusted until narrowed by the codec
    static encode(error: unknown): ApiErrorPayload {
        return this.encodeDepth(error, 0);
    }

    // webpieces-disable no-function-outside-class -- recursive bounded wire codec; webpieces-disable no-any-unknown -- thrown causes require runtime narrowing
    private static encodeDepth(error: unknown, depth: number): ApiErrorPayload {
        const kind = this.kind(error);
        const payload = new ApiErrorPayload(
            kind,
            error instanceof UserError ? error.message.slice(0, 4096) : this.message(kind),
        );
        if (error instanceof ApiError) payload.subType = this.text(error.subType);
        if (error instanceof UserError) payload.errorCode = this.text(error.errorCode);
        if (error instanceof BadRequestError) {
            payload.field = this.text(error.field);
            payload.guiAlertMessage = this.text(error.guiMessage);
        }
        if (error instanceof VendorError) payload.waitSeconds = this.wait(error.waitSeconds);
        if (error instanceof Error && depth < 3) {
            const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
            if (cause instanceof Error) payload.cause = this.encodeDepth(cause, depth + 1);
        }
        return payload;
    }

    // webpieces-disable no-function-outside-class -- stateless public codec shared by transport adapters; webpieces-disable no-any-unknown -- JSON transport input must be validated before use
    static decode(value: unknown): ApiError {
        return this.decodeDepth(value, 0);
    }

    // webpieces-disable no-function-outside-class -- recursive bounded wire codec; webpieces-disable no-any-unknown -- remote causes remain untrusted until validated
    private static decodeDepth(value: unknown, depth: number): ApiError {
        const error = this.decodeOne(value);
        if (typeof value === 'object' && value !== null && depth < 3) {
            const cause = Object.getOwnPropertyDescriptor(value, 'cause')?.value;
            if (typeof cause === 'object' && cause !== null) {
                // webpieces-disable no-anonymous-object-literals -- standard property descriptor keeps Error.cause non-enumerable
                Object.defineProperty(error, 'cause', {
                    value: this.decodeDepth(cause, depth + 1),
                    configurable: true,
                    writable: true,
                });
            }
        }
        return error;
    }

    // webpieces-disable no-function-outside-class -- allowlisted wire codec; webpieces-disable no-any-unknown -- JSON transport input must be validated before use
    private static decodeOne(value: unknown): ApiError {
        if (typeof value !== 'object' || value === null) return new InternalError('Internal Error');
        // webpieces-disable no-any-unknown -- own wire fields remain untrusted until narrowed
        const field = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
        const kind = field('kind');
        const message = this.text(field('message')) ?? this.message(kind);
        switch (kind) {
            case 'user':
                return new UserError(message, this.text(field('errorCode')));
            case 'bad-request':
                return new BadRequestError(
                    message,
                    this.text(field('field')),
                    this.text(field('guiAlertMessage')),
                );
            case 'unauthorized':
                return new UnauthorizedError(message, this.text(field('subType')));
            case 'forbidden':
                return new ForbiddenError(message);
            case 'not-found':
                return new NotFoundError(message);
            case 'endpoint-not-found':
                return new EndpointNotFoundError(message);
            case 'request-timeout':
                return new RequestTimeoutError(message);
            case 'too-many-requests':
                return new TooManyRequestsError(message);
            case 'bad-gateway':
                return new BadGatewayError(message);
            case 'service-unavailable':
                return new ServiceUnavailableError(message);
            case 'gateway-timeout':
                return new GatewayTimeoutError(message);
            case 'vendor':
                return new VendorError(message, this.wait(field('waitSeconds')));
            case 'offline':
                return new OfflineError(message);
            case 'internal':
                return new InternalError(message);
            default:
                return new InternalError('Internal Error');
        }
    }

    // webpieces-disable no-function-outside-class -- helper of stateless codec; webpieces-disable no-any-unknown -- thrown values need instanceof narrowing before encoding
    private static kind(error: unknown): string {
        if (error instanceof UserError) return 'user';
        if (error instanceof BadRequestError) return 'bad-request';
        if (error instanceof UnauthorizedError) return 'unauthorized';
        if (error instanceof ForbiddenError) return 'forbidden';
        if (error instanceof EndpointNotFoundError) return 'endpoint-not-found';
        if (error instanceof NotFoundError) return 'not-found';
        if (error instanceof RequestTimeoutError) return 'request-timeout';
        if (error instanceof TooManyRequestsError) return 'too-many-requests';
        if (error instanceof BadGatewayError) return 'bad-gateway';
        if (error instanceof ServiceUnavailableError) return 'service-unavailable';
        if (error instanceof GatewayTimeoutError) return 'gateway-timeout';
        if (error instanceof VendorError) return 'vendor';
        if (error instanceof OfflineError) return 'offline';
        return 'internal';
    }
    // webpieces-disable no-function-outside-class -- helper of stateless codec; webpieces-disable no-any-unknown -- wire fields need runtime string checks
    private static text(value: unknown): string | undefined {
        return typeof value === 'string' ? value.slice(0, 4096) : undefined;
    }
    // webpieces-disable no-function-outside-class -- helper of stateless codec; webpieces-disable no-any-unknown -- wire fields need runtime finite number checks
    private static wait(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? Math.min(value, 86400)
            : undefined;
    }
    // webpieces-disable no-function-outside-class -- helper of stateless codec; webpieces-disable no-any-unknown -- wire discriminator must be allowlisted before selection
    private static message(kind: unknown): string {
        switch (kind) {
            case 'user':
                return 'User Error';
            case 'bad-request':
                return 'Bad Request';
            case 'unauthorized':
                return 'Unauthorized';
            case 'forbidden':
                return 'Forbidden';
            case 'not-found':
                return 'Not Found';
            case 'endpoint-not-found':
                return 'Endpoint Not Found';
            case 'request-timeout':
                return 'Request Timeout';
            case 'too-many-requests':
                return 'Too Many Requests';
            case 'bad-gateway':
                return 'Bad Gateway';
            case 'service-unavailable':
                return 'Service Unavailable';
            case 'gateway-timeout':
                return 'Gateway Timeout';
            case 'vendor':
                return 'Vendor Error';
            case 'offline':
                return 'Offline';
            default:
                return 'Internal Error';
        }
    }
}
