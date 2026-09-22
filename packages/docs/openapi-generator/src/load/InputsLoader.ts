import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiDocExtractor } from '@webpieces/api-doc-model';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ManifestLoader } from '../manifest/ManifestLoader';
import { ApiEntry, OpenApiManifest, ResponseHeaderEntry } from '../manifest/OpenApiManifest';
import {
    ContractModel,
    GenerationInputs,
    ResolvedResponseHeader,
} from '../generate/GenerationInputs';
import { ExportedConstantFolder } from './ExportedConstantFolder';
import { ForeignFailure } from './ForeignFailure';

/**
 * The compiler options the contracts are read with, when the project has no `tsconfig.json` of its
 * own to inherit from (see {@link InputsLoader.compilerOptions}).
 *
 * Decorators must be enabled or a contract does not parse at all, and `skipLibCheck` is on because
 * this is an EXTRACTION pass, not a type-check: the app's own build is what decides whether the
 * contract compiles, and duplicating that judgement here would make `wp-openapi` fail for reasons
 * that have nothing to do with the document.
 */
const FALLBACK_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
};

/**
 * Read everything from disk, ONCE, into {@link GenerationInputs}.
 *
 * Every path in the manifest is resolved against the MANIFEST's own directory, never against the
 * process's cwd. A document whose contents depended on where `wp-openapi` was invoked from would be
 * a different document per caller, and the committed golden would go red depending on which
 * directory a build happened to run in.
 */
export class InputsLoader {
    private readonly manifests = new ManifestLoader();
    private readonly constants = new ExportedConstantFolder();
    private readonly extractor = new ApiDocExtractor();
    private options: ts.CompilerOptions = FALLBACK_OPTIONS;

    load(manifestPath: string): GenerationInputs {
        const manifest = this.manifests.load(manifestPath);
        this.options = this.compilerOptions(manifestPath);
        return new GenerationInputs(
            manifestPath,
            manifest,
            this.contracts(manifestPath, manifest),
            this.errorType(manifestPath, manifest),
            this.responseHeaders(manifestPath, manifest),
            this.description(manifestPath, manifest),
        );
    }

    /**
     * The nearest `tsconfig.json` at or above the MANIFEST, with the extraction flags forced on.
     *
     * A contract imports its decorators from `@webpieces/core-util`, and a path mapping or a
     * `baseUrl` is what makes that name resolve. Reading the project's own tsconfig is therefore not
     * a convenience — without it the checker cannot see that `POST` is the string `'POST'`, and the
     * constant folder does the right thing and REFUSES rather than guessing a verb. Falling back to
     * a fixed set of options is for a caller with no tsconfig at all, which is a legal thing to be.
     *
     * The flags below are forced over whatever the project says because they are about THIS read and
     * not about the project's build: decorators must parse, nothing may be emitted, and a library
     * type error in `node_modules` is the project's business, not a reason to refuse a document.
     */
    private compilerOptions(manifestPath: string): ts.CompilerOptions {
        const configFile = ts.findConfigFile(path.dirname(manifestPath), (file: string) =>
            ts.sys.fileExists(file),
        );
        if (configFile === undefined) {
            return FALLBACK_OPTIONS;
        }
        const read = ts.readConfigFile(configFile, (file: string) => ts.sys.readFile(file));
        if (read.error !== undefined || read.config === undefined) {
            return FALLBACK_OPTIONS;
        }
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile));
        const options = parsed.options;
        options.noEmit = true;
        options.skipLibCheck = true;
        options.experimentalDecorators = true;
        options.composite = false;
        options.declaration = false;
        return options;
    }

    private contracts(manifestPath: string, manifest: OpenApiManifest): readonly ContractModel[] {
        return manifest.apis.map((entry: ApiEntry) => {
            const file = this.manifests.resolve(manifestPath, entry.entry);
            this.mustExist(file, entry.entry, manifestPath);
            return new ContractModel(entry, this.extract(file), file);
        });
    }

    /**
     * The extractor's own failure is re-thrown as THIS package's one error type, carrying the
     * extractor's location and cure. The alternative — letting `ApiDocExtractionError` out — would
     * give `wp-openapi` two failure types that its top-level handler had to know about, and only one
     * of them would be documented on this package's surface.
     */
    private extract(file: string): ReturnType<ApiDocExtractor['extractFile']> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- re-thrown as the ONE error type of this package
        try {
            return this.extractor.extractFile(file, this.options);
        } catch (err: unknown) {
            //const error = toError(err);
            throw this.rethrow(err, file);
        }
    }

    private errorType(
        manifestPath: string,
        manifest: OpenApiManifest,
    ): ReturnType<ApiDocExtractor['extractType']> | undefined {
        const errors = manifest.errors;
        if (errors === undefined) {
            return undefined;
        }
        const file = this.manifests.resolve(manifestPath, errors.entry);
        this.mustExist(file, errors.entry, manifestPath);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- re-thrown as the ONE error type of this package
        try {
            return this.extractor.extractType(file, errors.type, this.options);
        } catch (err: unknown) {
            //const error = toError(err);
            throw this.rethrow(err, file);
        }
    }

    // webpieces-disable no-any-unknown -- a caught value; ForeignFailure is what narrows it
    private rethrow(err: unknown, file: string): OpenApiGenerationError {
        if (err instanceof OpenApiGenerationError) {
            return err;
        }
        return ForeignFailure.of(err).asGenerationError(
            file,
            'Fix the contract this document is read from.',
        );
    }

    private responseHeaders(
        manifestPath: string,
        manifest: OpenApiManifest,
    ): readonly ResolvedResponseHeader[] {
        return manifest.responseHeaders.map((header: ResponseHeaderEntry) => {
            const file = this.manifests.resolve(manifestPath, header.entry);
            return new ResolvedResponseHeader(
                this.constants.fold(file, header.nameConstant),
                header.description,
            );
        });
    }

    private description(manifestPath: string, manifest: OpenApiManifest): string | undefined {
        if (manifest.descriptionFile === undefined) {
            return undefined;
        }
        const file = this.manifests.resolve(manifestPath, manifest.descriptionFile);
        this.mustExist(file, manifest.descriptionFile, manifestPath);
        return fs.readFileSync(file, 'utf8').trim();
    }

    private mustExist(file: string, declared: string, manifestPath: string): void {
        if (!fs.existsSync(file)) {
            throw new OpenApiGenerationError(
                `the manifest names '${declared}', which does not exist`,
                manifestPath,
                `Paths are relative to the manifest's own directory. Expected it at ${file}.`,
            );
        }
    }
}
