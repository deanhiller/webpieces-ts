/** One HTTP header occurrence; a list preserves repeated Set-Cookie headers. */
export class HttpHeader {
    constructor(
        public readonly name: string,
        public readonly value: string,
    ) {}
}
/** Transport-neutral status. Express and fetch own the HTTP version. */
export class HttpResponseStatus {
    constructor(
        public readonly code: number,
        public readonly reason: string,
    ) {}
}
/** Entire response, shared by server and client translators. */
export class HttpResponseDto {
    constructor(
        public readonly status: HttpResponseStatus,
        public readonly headers: readonly HttpHeader[],
        // webpieces-disable no-any-unknown -- an application-defined JSON or text response
        public readonly body: unknown,
    ) {}
}
