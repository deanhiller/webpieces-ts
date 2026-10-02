import { StreamingEndpointMetadata, StreamingSchemaCatalog } from '@webpieces/core-util';
import { ApiDocModel } from '../model/ApiDocModel';
import { McpSchemaRenderer } from './McpSchemaRenderer';

/** Emits the runtime schemas derived by the same model used for API documentation. */
export class StreamingSchemaRenderer {
    render(model: ApiDocModel): StreamingSchemaCatalog {
        const schemas = new McpSchemaRenderer(model, false);
        const methods: Record<string, StreamingEndpointMetadata> = {};
        for (const endpoint of model.endpoints) {
            const stream = endpoint.streaming;
            if (!stream) continue;
            const where = `${model.contractName}.${endpoint.methodName}`;
            methods[endpoint.methodName] = new StreamingEndpointMetadata(
                stream.direction,
                schemas.schemaFor(stream.initialRequest, `${where}.initialRequest`),
                schemas.schemaFor(stream.initialResponse, `${where}.initialResponse`),
                stream.requestEvent
                    ? schemas.schemaFor(stream.requestEvent, `${where}.requestEvent`)
                    : undefined,
                stream.responseEvent
                    ? schemas.schemaFor(stream.responseEvent, `${where}.responseEvent`)
                    : undefined,
            );
        }
        return new StreamingSchemaCatalog(model.contractName, methods);
    }
}
