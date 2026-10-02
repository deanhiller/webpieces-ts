import { DtoValue, StreamDisconnectedError } from '@webpieces/core-util';
import { ByteReadableStream, ByteStreamReader } from '../../ByteStream';
import { ClientRequest } from '../../ClientRequest';
import { HttpTransport } from '../../HttpTransport';
import { Utf8Codec } from '../../Utf8Codec';

/** A response stream whose headers, chunks, clean EOF, and reset are controlled by a feature test. */
export class ControlledHttpResponse {
    private controller!: ReadableStreamDefaultController<Uint8Array>;
    readonly body = new ReadableStream<Uint8Array>({
        start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
            this.controller = controller;
        },
    });
    private readonly codec = new Utf8Codec();

    enqueueJsonLine(value: DtoValue): void {
        this.enqueueBytes(this.codec.encode(`${JSON.stringify(value)}\n`));
    }
    enqueueBytes(bytes: Uint8Array): void {
        this.controller.enqueue(bytes);
    }
    end(): void {
        this.controller.close();
    }
    fail(error: Error): void {
        this.controller.error(error);
    }
}

/** Owns one real generated request and exposes its bytes without mocking mapping or parsers. */
export class ControlledHttpCall {
    private readonly reader: ByteStreamReader;
    private readonly codec = new Utf8Codec();
    private pending = '';
    private resolveResponse!: (response: Response) => void;
    private rejectResponse!: (error: Error) => void;
    private response?: ControlledHttpResponse;
    aborted = false;
    readonly reply = new Promise<Response>(
        (resolve: (response: Response) => void, reject: (error: Error) => void): void => {
            this.resolveResponse = resolve;
            this.rejectResponse = reject;
        },
    );

    constructor(
        readonly request: ClientRequest,
        signal: AbortSignal,
        body?: ByteReadableStream,
    ) {
        const finiteBody = new ReadableStream<Uint8Array>({
            start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
                controller.enqueue(this.codec.encode(String(request.body ?? '')));
                controller.close();
            },
        });
        this.reader = (body ?? finiteBody).getReader();
        const aborted = (): void => {
            this.aborted = true;
            const error = new StreamDisconnectedError('Controlled transport aborted.');
            this.rejectResponse(error);
            this.response?.fail(error);
        };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
    }

    async nextJsonLine(): Promise<DtoValue | undefined> {
        const line = await this.nextRawLine();
        return line === undefined ? undefined : (JSON.parse(line) as DtoValue);
    }

    async nextRawLine(): Promise<string | undefined> {
        for (;;) {
            const newline = this.pending.indexOf('\n');
            if (newline >= 0) {
                const line = this.pending.slice(0, newline);
                this.pending = this.pending.slice(newline + 1);
                return line;
            }
            const chunk = await this.reader.read();
            this.pending += this.codec.decode(chunk.value, !chunk.done);
            if (chunk.done) return undefined;
        }
    }

    respondStream(
        status = 200,
        headers: Record<string, string> = { 'content-type': 'application/x-webpieces-jsonl' },
    ): ControlledHttpResponse {
        const response = new ControlledHttpResponse();
        this.response = response;
        this.resolveResponse(new Response(response.body, { status, headers }));
        return response;
    }
}

/** Source-only utility; never exported or published as a package API. */
export class ControlledHttpTransport implements HttpTransport {
    private readonly calls: ControlledHttpCall[] = [];
    private readonly waiters: Array<(call: ControlledHttpCall) => void> = [];

    send(
        request: ClientRequest,
        signal: AbortSignal,
        body?: ByteReadableStream,
    ): Promise<Response> {
        const call = new ControlledHttpCall(request, signal, body);
        const waiter = this.waiters.shift();
        if (waiter) waiter(call);
        else this.calls.push(call);
        return call.reply;
    }

    nextRequest(): Promise<ControlledHttpCall> {
        const call = this.calls.shift();
        if (call) return Promise.resolve(call);
        return new Promise<ControlledHttpCall>(
            (resolve: (value: ControlledHttpCall) => void): void => {
                this.waiters.push(resolve);
            },
        );
    }
}
