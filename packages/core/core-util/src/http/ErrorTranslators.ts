import { HttpResponseDto } from './HttpResponseDto';
/** One process-wide strategy, shared by the server and every HTTP client. */
export interface ErrorTranslators {
    /** Server: exception to entire response. Undefined delegates to the default. */
    toWire(error: Error): HttpResponseDto | undefined;
    /** Client: entire response to exception. Undefined delegates to the default. */
    fromWire(response: HttpResponseDto): Error | undefined;
}
