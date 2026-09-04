/** A single HTTP header. Kept as a list entry because HTTP header names may repeat. */
export class HttpHeader {
    constructor(
        public readonly name: string,
        public readonly value: string,
    ) {}
}

/** The complete status-line information transports allow an application to choose. */
export class HttpResponseStatus {
    constructor(
        public readonly code: number,
        public readonly reason: string,
    ) {}
}

/** Transport-neutral HTTP response data shared by the server and every client. */
export class HttpResponseDto {
    constructor(
        public readonly status: HttpResponseStatus,
        public readonly headers: readonly HttpHeader[],
        // webpieces-disable no-any-unknown -- response bodies are application DTOs, normalized before their concrete contract is known
        public readonly body: unknown,
    ) {}
}
