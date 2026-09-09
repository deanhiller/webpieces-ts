import { IpcContract, IpcMethod, IpcMethods, IpcSchema } from './IpcContract';
import { MaskSpec } from '../http/LogFieldMask';
class Request {
    constructor(readonly id: string) {}
}
class Schema implements IpcSchema<Request> {
    // webpieces-disable no-any-unknown -- untrusted IPC data is schema-validated; generic dispatch cannot assume a DTO type before validation
    parse(value: unknown): Request {
        if (!(value instanceof Request)) throw new Error('Expected Request');
        return value;
    }
}
abstract class Api {
    abstract first(request: Request): Promise<Request>;
    abstract second(request: Request): Promise<Request>;
}
class Incomplete {
    readonly first = new IpcMethod('first', new Schema(), new Schema(), new MaskSpec({}));
}
abstract class MultipleApi {
    abstract bad(a: Request, b: Request): Promise<Request>;
}
/** These assertions compile in package builds, unlike transpiled-only spec files. Never invoked. */
export class IpcCompileAssertions {
    // webpieces-disable no-function-outside-class -- portable stateless IPC primitive; no platform DI container exists on this boundary
    static assertExhaustiveMetadata(): void {
        // @ts-expect-error every API member needs explicit runtime metadata
        new IpcContract('incomplete', Api, new Incomplete());
        // @ts-expect-error multi-argument API methods are not IPC DTO contracts
        const multiple: IpcMethods<MultipleApi> = new Incomplete();
        void multiple;
    }
}
