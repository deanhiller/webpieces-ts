/**
 * openapi-components-generate Executor (#1058)
 *
 * Renders a DTO library's components-only OpenAPI document, `components.openapi.json` — every type
 * the library exports and declares, `info.version` = the package version — INTO the outputPath of the
 * target it dependsOn (the library's `build`), so it ships inside the library's npm package exactly as
 * a contract library's documents do. Contract documents `$ref` its schemas instead of copying them.
 *
 * Consumers do not declare this executor. The nx-webpieces-rules plugin INFERS the target on a project
 * tagged `generate:openapi-components`; project.json states only the consumer's values:
 *
 *   "tags": ["generate:openapi-components"],
 *   "targets": {
 *     "openapi-components-generate": {
 *       "dependsOn": ["build", "^openapi-components-generate"],
 *       "options": { "manifest": "<project>/openapi.manifest.json", "format": "json" }
 *     }
 *   }
 *
 * where the manifest declares `"kind": "components"` and names the library's entry files. Only a
 * `role:api-lib` project may carry the tag (#1064, D5) — it is refused here and in validate-nx-wiring. The
 * `^openapi-components-generate` edge orders a chain of DTO libraries; a contract library's
 * `openapi-generate` carries the same edge. validate-nx-wiring enforces both (ComponentsWiring).
 *
 * It is the openapi-generate executor body with its own target name and generator minimum: `wp-openapi`
 * reads the manifest's `kind` and decides what to render.
 */

import type { ExecutorContext } from '@nx/devkit';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { ExecutorResult } from '../../executor-result';
import { OPENAPI_COMPONENTS_GENERATOR } from '../../lib/api-docs/generator-package';
import {
    GenerateExecutorMain,
    GenerateSpec,
    OpenApiGenerateOptions,
} from '../openapi-generate/executor';

/** `openapi-components-generate`: a DTO library's `components.openapi.json`. */
export const COMPONENTS_DOCUMENT = new GenerateSpec(
    GeneratedApiDocsLayout.COMPONENTS_TARGET,
    OPENAPI_COMPONENTS_GENERATOR,
    // #1064 (D5): only a role:api-lib publishes the schemas contract documents $ref.
    'api-lib',
);

// webpieces-disable no-function-outside-class -- nx executor module: nx resolves a default-export function here
export default async function runExecutor(
    options: OpenApiGenerateOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return GenerateExecutorMain.run(COMPONENTS_DOCUMENT, options, context);
}
