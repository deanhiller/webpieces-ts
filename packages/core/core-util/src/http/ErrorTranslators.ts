import { HttpResponseDto } from './HttpResponseDto';

/** App-owned, symmetric translation between exceptions and complete HTTP responses. */
export interface ErrorTranslators {
    /** SERVER: exception -> entire response. Undefined delegates to webpieces. */
    toWire(error: Error): HttpResponseDto | undefined;

    /** CLIENT: entire response -> typed exception. Undefined delegates to webpieces. */
    fromWire(response: HttpResponseDto): Error | undefined;
}
