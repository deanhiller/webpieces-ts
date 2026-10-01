import * as fs from 'node:fs';
import * as path from 'node:path';

/** The npm package a source file belongs to: the nearest `package.json` above it. Data-only. */
export class DeclaringPackage {
    constructor(
        /** `name` from that `package.json`, e.g. `@myorg/lang-api-dtos`. */
        readonly name: string,
        /** `version` from that `package.json`; the empty string when it states none. */
        readonly version: string,
        /** The absolute directory holding that `package.json`. */
        readonly directory: string,
    ) {}
}

/** The two fields of a `package.json` this lookup reads. */
type PackageJsonFields = { readonly name?: unknown; readonly version?: unknown };

/**
 * WHICH PACKAGE declares a type — the owner of its schema (#1058).
 *
 * A schema is defined in exactly one OpenAPI document: the one belonging to the package whose source
 * declares the TypeScript type. That is what lets two different `LocalizedDescriptionsDto`s live in
 * two packages without colliding, and what lets a contract document `$ref` a DTO library's schema
 * instead of copying it. The answer is the nearest `package.json` above the declaring file — which is
 * the same answer whether the compiler reached the file as workspace SOURCE through tsconfig `paths`
 * or as a published `.d.ts` under `node_modules`.
 *
 * A file with no `package.json` above it belongs to no package; `of` returns `undefined` and the
 * caller decides what that means (the OpenAPI generator refuses to reference it, the MCP renderer
 * does not care).
 *
 * Cached per directory, because a contract reaches hundreds of declarations in a handful of files.
 */
export class PackageOfFile {
    private readonly byDirectory = new Map<string, DeclaringPackage | undefined>();

    /** The package declaring `fileName`, or undefined when no `package.json` with a name is above it. */
    of(fileName: string): DeclaringPackage | undefined {
        return this.ofDirectory(path.dirname(path.resolve(fileName)));
    }

    private ofDirectory(directory: string): DeclaringPackage | undefined {
        if (this.byDirectory.has(directory)) {
            return this.byDirectory.get(directory);
        }
        const found = this.read(directory) ?? this.parentOf(directory);
        this.byDirectory.set(directory, found);
        return found;
    }

    private parentOf(directory: string): DeclaringPackage | undefined {
        const parent = path.dirname(directory);
        return parent === directory ? undefined : this.ofDirectory(parent);
    }

    /** The package whose `package.json` sits in `directory`, when it is one with a name. */
    private read(directory: string): DeclaringPackage | undefined {
        const file = path.join(directory, 'package.json');
        if (!fs.existsSync(file)) {
            return undefined;
        }
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJsonFields;
        if (typeof raw.name !== 'string' || raw.name.trim() === '') {
            return undefined;
        }
        return new DeclaringPackage(
            raw.name,
            typeof raw.version === 'string' ? raw.version : '',
            directory,
        );
    }
}
