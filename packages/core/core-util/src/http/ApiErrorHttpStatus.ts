import { ApiError } from '../errors/ApiError';

/** HTTP-only adapter: semantic errors themselves have no protocol status property. */
export class ApiErrorHttpStatus {
    // webpieces-disable no-function-outside-class -- stateless mapping predicate
    static hasCode(error: ApiError): boolean {
        return error.kind !== 'connection';
    }

    // webpieces-disable no-function-outside-class -- stateless mapping shared by HTTP adapters
    static code(error: ApiError): number {
        switch (error.kind) {
            case 'end-user':
                return 266;
            case 'bad-request':
                return 400;
            case 'unauthorized':
                return 401;
            case 'forbidden':
                return 403;
            case 'not-found':
            case 'endpoint-not-found':
                return 404;
            case 'request-timeout':
                return 408;
            case 'rate-limited':
                return 429;
            case 'implementation':
                return 500;
            case 'dependency':
                return 502;
            case 'unavailable':
            case 'dependency-backoff':
                return 503;
            case 'dependency-timeout':
                return 504;
            case 'connection':
                throw new Error(
                    'ApiConnectionError has no HTTP status; normalize it at the server boundary',
                );
        }
    }
}
