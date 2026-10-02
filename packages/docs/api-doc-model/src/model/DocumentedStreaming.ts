import { StreamDirection } from '@webpieces/core-util';
import { TypeRef } from './TypeRef';

/** Direction and DTO slots derived from a streaming declaration, independent of extraction. */
export class DocumentedStreaming {
    constructor(
        readonly direction: StreamDirection,
        readonly initialRequest: TypeRef,
        readonly initialResponse: TypeRef,
        readonly requestEvent: TypeRef | undefined,
        readonly responseEvent: TypeRef | undefined,
    ) {}
}
