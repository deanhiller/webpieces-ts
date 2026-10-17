import { StreamingEndpointMetadata, StreamingSchemaCatalog } from '@webpieces/core-util';
import { ApiDocModel } from '../model/ApiDocModel';
import { McpSchemaRenderer } from './McpSchemaRenderer';
import { McpRenderError } from './McpRenderError';
import { DocLinkProblem } from '../model/DocLink';
import { OperationIds } from '../model/OperationIds';

/** Emits the runtime schemas derived by the same model used for API documentation. */
export class StreamingSchemaRenderer {
    /** @param operationIds the manifest's operationId spelling, for a `{@link}` to a method (#1284). */
    constructor(private readonly operationIds: OperationIds) {}

    render(model: ApiDocModel): StreamingSchemaCatalog {
        const schemas = new McpSchemaRenderer(model, this.operationIds, false);
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
        const problems = schemas.linkProblems();
        if (problems.length > 0) {
            throw new McpRenderError(
                `${problems.length} {@link} reference(s) in streaming schema prose name nothing ` +
                    `published: ${problems.map((each: DocLinkProblem) => each.toString()).join('; ')}`,
                model.contractName,
                'Point each {@link} at a published type or an @Endpoint method of an @ApiPath ' +
                    'contract, imported into the file the JSDoc is in, or write the name as plain text.',
            );
        }
        return new StreamingSchemaCatalog(model.contractName, methods);
    }
}
