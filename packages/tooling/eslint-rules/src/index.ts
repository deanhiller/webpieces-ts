/**
 * ESLint plugin for WebPieces
 * Provides rules for enforcing WebPieces code patterns
 *
 * This plugin is automatically included in @webpieces/nx-webpieces-rules
 *
 * Available rules:
 * - catch-error-pattern: Enforce toError() usage in catch blocks (HOW to handle)
 * - no-unmanaged-exceptions: Discourage try-catch outside tests (WHERE to handle)
 * - max-method-lines: Enforce maximum method length (default: 70 lines)
 * - max-file-lines: Enforce maximum file length (default: 700 lines)
 * - enforce-architecture: Enforce architecture dependency boundaries
 * - no-json-property-primitive-type: Ban @JsonProperty({ type: String/Number/Boolean })
 * - require-typed-template: Require [templateClassType] on ng-template with let- variables (Angular)
 * - no-mat-cell-def: Ban *matCellDef/*matHeaderCellDef — use div-grid tables (Angular)
 */

import catchErrorPattern from './rules/catch-error-pattern';
import noUnmanagedExceptions from './rules/no-unmanaged-exceptions';
import maxMethodLines from './rules/max-method-lines';
import maxFileLines from './rules/max-file-lines';
import enforceArchitecture from './rules/enforce-architecture';
import noJsonPropertyPrimitiveType from './rules/no-json-property-primitive-type';
import requireTypedTemplate from './rules/require-typed-template';
import noMatCellDef from './rules/no-mat-cell-def';

export = {
    rules: {
        'catch-error-pattern': catchErrorPattern,
        'no-unmanaged-exceptions': noUnmanagedExceptions,
        'max-method-lines': maxMethodLines,
        'max-file-lines': maxFileLines,
        'enforce-architecture': enforceArchitecture,
        'no-json-property-primitive-type': noJsonPropertyPrimitiveType,
        'require-typed-template': requireTypedTemplate,
        'no-mat-cell-def': noMatCellDef,
    },
};
