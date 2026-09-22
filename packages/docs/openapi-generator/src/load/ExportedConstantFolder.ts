import * as fs from 'node:fs';
import * as ts from 'typescript';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * Fold an exported `const` out of a `.ts` file — the header NAME behind a manifest's `nameConstant`.
 *
 * ## Why the manifest names a CONSTANT and not the header
 *
 * JSON cannot import. A header name written as a literal in `openapi.manifest.json` is a copy of the
 * one the server writes, and a rename leaves the copy silently stale — the published document then
 * documents a header nothing sets, which no test can catch because both files are internally
 * consistent. Naming the constant makes the manifest point at the same declaration the server reads.
 *
 * ## Why it HARD-FAILS instead of falling back to the constant's text
 *
 * The fallback would publish `REQUEST_ID_HEADER` as a header name. That is a document that is wrong
 * in a way a reader cannot detect, which is the one failure mode a generated document exists to
 * remove. It is the same call `ConstantFolder` makes about an `@Endpoint` path, for the same reason.
 */
export class ExportedConstantFolder {
    /** @param file absolute path to the `.ts` file declaring the constant. */
    fold(file: string, constantName: string): string {
        if (!fs.existsSync(file)) {
            throw new OpenApiGenerationError(
                `no file declaring '${constantName}'`,
                file,
                'Point `entry` at the .ts file that exports the constant.',
            );
        }
        const source = ts.createSourceFile(
            file,
            fs.readFileSync(file, 'utf8'),
            ts.ScriptTarget.ES2022,
            /*setParentNodes*/ true,
        );
        const value = this.find(source, constantName);
        if (value === undefined) {
            throw new OpenApiGenerationError(
                `'${constantName}' is not an exported string constant in this file`,
                file,
                `Declare it as \`export const ${constantName} = '<header-name>';\` — a value only ` +
                    'known at runtime cannot appear in a published document.',
            );
        }
        return value;
    }

    private find(source: ts.SourceFile, constantName: string): string | undefined {
        for (const statement of source.statements) {
            if (!ts.isVariableStatement(statement)) {
                continue;
            }
            for (const declaration of statement.declarationList.declarations) {
                if (
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === constantName &&
                    declaration.initializer !== undefined &&
                    ts.isStringLiteralLike(declaration.initializer)
                ) {
                    return declaration.initializer.text;
                }
            }
        }
        return undefined;
    }
}
