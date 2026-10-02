import { ApiJsonSchema } from '../mcp/DtoSchema';
import { RequestStream, ResponseStream, StreamDirection, WpStream } from './StreamingContract';

class StreamMigrationAssertions {
    check(response: ResponseStream<string>, request: RequestStream<string, number>): void {
        WpStream(StreamDirection.FULL);
        // @ts-expect-error -- WpStream accepts direction only; schemas come from the build model
        WpStream(new ApiJsonSchema('object'), new ApiJsonSchema('object'));
        // @ts-expect-error -- graceful EOF is close()
        response.complete();
        // @ts-expect-error -- abnormal termination is cancel(error?)
        response.fail(new Error('cancel'));
        // @ts-expect-error -- implement cancel(error?) directly on the peer stream
        response.onCancel(() => undefined);
        // @ts-expect-error -- initial response and later request events require two generics
        const old: RequestStream<string> = request;
        void old;
    }
}
void StreamMigrationAssertions;
