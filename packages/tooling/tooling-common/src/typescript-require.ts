import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';

/** A TypeScript module file `require` may load through {@link TypeScriptRequire}. `.mts` is ESM-only. */
const TYPESCRIPT_FILE = /\.c?ts$/;

/** The slice of Node's CommonJS module object an extension handler compiles into. */
interface CompilableModule {
    _compile(code: string, filename: string): void;
}

type ExtensionHandler = (module: CompilableModule, filename: string) => void;

/**
 * Loads a repo's OWN TypeScript rule-pack module (#1314) without a build step: while one `require` of a
 * `.ts` / `.cts` file runs, every TypeScript file it pulls in is transpiled to CommonJS in memory with the
 * `typescript` webpieces already ships. A consumer repo therefore writes its local rules in TypeScript —
 * the only language its own `no-js-files` rule admits — and declares the `.ts` file in `rulePacks`.
 *
 * Node's built-in type stripping is not enough: it refuses parameter properties and enums
 * (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), which a rule written in this repo's style is full of.
 *
 * The handler is installed only for the duration of the call and the previous one is put back, so a
 * process that registers its own TypeScript loader (swc-node under nx, vitest) is left exactly as it was.
 * Transpilation is per file and type-free: a type error in a local rule is the repo's own build to catch.
 */
export class TypeScriptRequire {
    /** True when `file` is a TypeScript module this loader transpiles. */
    handles(file: string): boolean {
        return TYPESCRIPT_FILE.test(file);
    }

    // webpieces-disable no-any-unknown -- a required module's exports are opaque until its caller validates them
    load(requireModule: NodeRequire, file: string): unknown {
        if (!this.handles(file)) return requireModule(file);
        const extensions = requireModule.extensions as unknown as Record<string, ExtensionHandler | undefined>;
        const previous = new Map<string, ExtensionHandler | undefined>();
        for (const extension of ['.ts', '.cts']) {
            previous.set(extension, extensions[extension]);
            extensions[extension] = (module: CompilableModule, filename: string): void => module._compile(this.transpile(filename), filename);
        }
        // webpieces-disable no-unmanaged-exceptions -- not a catch: `finally` restores the process's own loaders whether or not the module loads
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- see above
        try {
            return requireModule(file);
        } finally {
            for (const entry of previous) {
                if (entry[1] === undefined) delete extensions[entry[0]];
                else extensions[entry[0]] = entry[1];
            }
        }
    }

    private transpile(filename: string): string {
        const ts = createRequire(__filename)('typescript') as typeof TypeScript;
        return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            fileName: filename,
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
                experimentalDecorators: true,
                sourceMap: false,
            },
        }).outputText;
    }
}
