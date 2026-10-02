import { METADATA_KEYS } from './decorators';
import { getStreamingEndpoint, StreamingEndpointMetadata } from './StreamingContract';

/** Portable build output, imported as JSON identically by browser and server bootstraps. */
export class StreamingSchemaCatalog {
    constructor(
        readonly contractName: string,
        readonly methods: Record<string, StreamingEndpointMetadata>,
    ) {}
}

/** Installs generated runtime schemas; contract authors never repeat their DTO types here. */
// webpieces-disable no-function-outside-class -- generated catalog bootstrap is a public metadata boundary
export function registerStreamingCatalog(
    apiClass: Function,
    catalog: StreamingSchemaCatalog,
): void {
    if (catalog.contractName !== apiClass.name) {
        throw new Error(
            `Streaming schema catalog for ${catalog.contractName} cannot bind ${apiClass.name}.`,
        );
    }
    const methods: Record<string, StreamingEndpointMetadata> = {};
    const declaredMethods: Record<string, StreamingEndpointMetadata> =
        Reflect.getMetadata(METADATA_KEYS.STREAM_ENDPOINTS, apiClass) ?? {};
    for (const methodName of Object.keys(declaredMethods)) {
        if (!catalog.methods[methodName]) {
            throw new Error(
                `Streaming catalog is missing ${apiClass.name}.${methodName}; regenerate it.`,
            );
        }
    }
    for (const entry of Object.entries(catalog.methods)) {
        const declared = getStreamingEndpoint(apiClass, entry[0]);
        if (!declared || declared.direction !== entry[1].direction) {
            throw new Error(
                `Streaming catalog direction disagrees with ${apiClass.name}.${entry[0]}; regenerate it.`,
            );
        }
        methods[entry[0]] = entry[1];
    }
    Reflect.defineMetadata(METADATA_KEYS.STREAM_ENDPOINTS, methods, apiClass);
}
