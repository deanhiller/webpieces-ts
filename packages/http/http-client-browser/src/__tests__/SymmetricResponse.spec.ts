import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
    ApiPath,
    ClientRegistry,
    Endpoint,
    ErrorTranslators,
    HeaderRegistry,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    Public,
    Rpc,
} from '@webpieces/core-util';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';
class OrderNotFoundError extends Error {}
class TestBody {
    constructor(public readonly orderId: string) {}
}
@Rpc()
@ApiPath('/orders')
abstract class TestApi {
    @Endpoint('/find', 'rpc')
    @Public()
    call(_request: TestBody): Promise<void> {
        throw new Error('contract only');
    }
}
class OrderErrorTranslators implements ErrorTranslators {
    received?: HttpResponseDto;
    toWire(error: Error): HttpResponseDto | undefined {
        if (!(error instanceof OrderNotFoundError)) return undefined;
        return new HttpResponseDto(
            new HttpResponseStatus(460, 'Order Not Found'),
            [
                new HttpHeader('content-type', 'application/json'),
                new HttpHeader('x-order-trace', 'trace-123'),
                new HttpHeader('set-cookie', 'first=1; Path=/; HttpOnly'),
                new HttpHeader('set-cookie', 'second=2; Path=/; HttpOnly'),
            ],
            new TestBody(error.message),
        );
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        this.received = response;
        if (response.status.code !== 460) return undefined;
        return new OrderNotFoundError((response.body as TestBody).orderId);
    }
}
let server: Server | undefined;
afterEach(async () => {
    ClientRegistry.clear();
    if (server)
        await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
        );
});
describe('browser client whole-response symmetry', () => {
    it('reconstructs the server error from status, reason, repeated headers and body', async () => {
        HeaderRegistry.configure([], true);
        ClientRegistry.clear();
        const translators = new OrderErrorTranslators();
        ClientRegistry.setErrorTranslators(translators);
        // Real HTTP fixture uses the same application policy on its server and client sides.
        server = createServer((_request, response) => {
            const wire = translators.toWire(new OrderNotFoundError('order-17'))!;
            response.writeHead(
                wire.status.code,
                wire.status.reason,
                wire.headers.flatMap((h) => [h.name, h.value]),
            );
            response.end(JSON.stringify(wire.body));
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        ClientRegistry.addUrlMapping(
            'symmetry-test',
            `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        );
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            TestApi,
            new ClientConfig('symmetry-test'),
        );
        await expect(client.call(new TestBody('order-17'))).rejects.toBeInstanceOf(
            OrderNotFoundError,
        );
        const dto = translators.received!;
        expect(dto).toBeInstanceOf(HttpResponseDto);
        expect(dto.status).toEqual(new HttpResponseStatus(460, 'Order Not Found'));
        expect(dto.body).toEqual(new TestBody('order-17'));
        expect(dto.headers).toContainEqual(new HttpHeader('x-order-trace', 'trace-123'));
        expect(dto.headers.filter((h) => h.name === 'set-cookie').map((h) => h.value)).toEqual([
            'first=1; Path=/; HttpOnly',
            'second=2; Path=/; HttpOnly',
        ]);
    });
});
