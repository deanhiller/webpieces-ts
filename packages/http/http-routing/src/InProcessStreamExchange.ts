import {
    ApiJsonSchema,
    DtoValue,
    RequestStream,
    ResponseStream,
    StreamEnvelope,
    StreamEventValidator,
    StreamTransportError,
    StreamWriter,
} from '@webpieces/core-util';
import { StreamEventContext } from '@webpieces/core-context';

/** One logical exchange coordinates both directions without reopening its initial context. */
export class InProcessStreamExchange {
    readonly response: StreamWriter<DtoValue>;
    clientRequest?: RequestStream<DtoValue, DtoValue>;
    private serverRequest?: RequestStream<DtoValue, DtoValue>;
    private events?: StreamEventContext;
    private cancelled = false;
    private readonly notifyClient: (error?: Error) => Promise<void>;

    constructor(
        private readonly destination: ResponseStream<DtoValue>,
        schema: ApiJsonSchema,
    ) {
        this.notifyClient = destination.cancel.bind(destination);
        destination.cancel = (error?: Error): Promise<void> => this.cancel(error);
        const validator = new StreamEventValidator();
        this.response = new StreamWriter<DtoValue>(
            (record: StreamEnvelope<DtoValue>): Promise<void> => this.deliver(record),
            (value: DtoValue): void => {
                this.requireAccepted();
                validator.validate(schema, value, 'response');
            },
            undefined,
            (error?: Error): Promise<void> => this.cancel(error),
        );
    }

    accept(serverRequest?: RequestStream<DtoValue, DtoValue>): void {
        this.serverRequest = serverRequest;
        this.events = new StreamEventContext();
    }

    async cancel(error?: Error): Promise<void> {
        if (this.cancelled) return;
        this.cancelled = true;
        await Promise.all([
            this.notifyClient(error),
            this.serverRequest?.cancel(error),
            this.clientRequest?.cancel(error),
            this.response.cancel(error),
        ]);
    }

    private async deliver(record: StreamEnvelope<DtoValue>): Promise<void> {
        this.requireAccepted();
        if (record.kind === 'complete') return this.destination.close();
        await this.events!.runOutbound((): Promise<void> => this.destination.event(record.value!));
    }

    private requireAccepted(): void {
        if (!this.events)
            throw new StreamTransportError(
                'Response events require a successful initial response.',
            );
    }
}
