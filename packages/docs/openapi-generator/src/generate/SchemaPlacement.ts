import { DocumentedType } from '@webpieces/api-doc-model';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';

/**
 * WHERE a named type's schema lives, from the point of view of ONE document being rendered (#1058).
 *
 * The model keys every type by its declaring package (`DocumentedType.keyOf`); a placement turns that
 * into the two facts a renderer needs — whether the schema is defined in THIS document's
 * `components.schemas` (and under what name), or referenced in another package's document — so the
 * three output forms are one renderer with three placements, not three renderers that could drift:
 *
 * | placement | used for | other packages' types |
 * |---|---|---|
 * | {@link SplitPlacement} | `full-private-openapi.json`, `public-openapi.json`, `components.openapi.json` | `$ref` into `<package>/components.openapi.json` |
 * | {@link BundledPlacement} | `*.bundled.json`, `mcp-openapi.json` | defined locally, renamed only on a name clash |
 * | {@link DiscoveryPlacement} | the first pass of a bundled render | defined locally under their unique key |
 */
export interface SchemaPlacement {
    /** True when `type` is defined in this document's own `components.schemas`. */
    isLocal(key: string, type: DocumentedType): boolean;
    /** The `components.schemas` key a LOCAL type is defined under. */
    localName(key: string, type: DocumentedType): string;
    /** The `$ref` value a reference to `type` is written as. */
    pointer(key: string, type: DocumentedType): string;
}

const LOCAL_POINTER = '#/components/schemas/';

/**
 * The package-qualified reference into a package's components document — decision 3 of #1058:
 * `@scope/pkg/components.openapi.json#/components/schemas/X`, resolved by the same package lookup
 * `McpToolCatalog.fromPackages` uses rather than by a `dist/` path.
 */
export class ComponentsReference {
    // webpieces-disable no-function-outside-class -- static helper on the class that owns the URI form
    static documentUri(packageName: string): string {
        return `${packageName}/${GeneratedApiDocsLayout.COMPONENTS_FILE}`;
    }

    // webpieces-disable no-function-outside-class -- static helper on the class that owns the URI form
    static to(packageName: string, schemaName: string): string {
        return `${ComponentsReference.documentUri(packageName)}#/components/schemas/${schemaName}`;
    }
}

/**
 * The SPLIT form: a schema is defined in the document of the package that declares it, and every
 * other package's schema is a `$ref` into that package's `components.openapi.json`. One owner per
 * schema — which is what removes both the duplicate copies and the name collisions of a flat namespace.
 */
export class SplitPlacement implements SchemaPlacement {
    constructor(
        /** The package this document is published by. */
        private readonly homePackage: string | undefined,
    ) {}

    isLocal(_key: string, type: DocumentedType): boolean {
        return type.packageName === this.homePackage;
    }

    localName(_key: string, type: DocumentedType): string {
        return type.name;
    }

    pointer(key: string, type: DocumentedType): string {
        if (this.isLocal(key, type)) {
            return `${LOCAL_POINTER}${type.name}`;
        }
        return ComponentsReference.to(type.packageName ?? '<no package>', type.name);
    }
}

/**
 * The BUNDLED form: every schema is defined locally, so the document has no external reference and
 * validates on its own. Names are assigned by {@link BundledNames}.
 */
export class BundledPlacement implements SchemaPlacement {
    constructor(private readonly names: ReadonlyMap<string, string>) {}

    isLocal(): boolean {
        return true;
    }

    localName(key: string, type: DocumentedType): string {
        return this.names.get(key) ?? type.name;
    }

    pointer(key: string, type: DocumentedType): string {
        return `${LOCAL_POINTER}${this.localName(key, type)}`;
    }
}

/**
 * The first pass of a bundled render, run only to learn WHICH types the document reaches: every type
 * is local under its unique model key, so nothing can collide before the names are chosen.
 */
export class DiscoveryPlacement implements SchemaPlacement {
    isLocal(): boolean {
        return true;
    }

    localName(key: string): string {
        return key;
    }

    pointer(key: string): string {
        return `${LOCAL_POINTER}${key}`;
    }
}

/**
 * The `components.schemas` names of a BUNDLED document.
 *
 * Every type keeps its own name unless two packages' types of ONE name are both reached — the
 * `LocalizedDescriptionsDto` case of #1058, which the split form keeps apart by keeping them in two
 * documents. A bundled document has one namespace, so then the home package's type keeps the bare
 * name and every other package's is qualified by its package (`myorg.lang-api-dtos.X`, in the
 * characters a components key may hold). Renaming only on a clash keeps every ordinary bundled
 * document identical to the split one wherever the split one defines the schema itself.
 */
export class BundledNames {
    // webpieces-disable no-function-outside-class -- static factory of this class
    static assign(
        reached: Iterable<string>,
        types: ReadonlyMap<string, DocumentedType>,
        homePackage: string | undefined,
    ): ReadonlyMap<string, string> {
        const byName = new Map<string, string[]>();
        for (const key of reached) {
            const type = types.get(key);
            if (type === undefined) {
                continue;
            }
            const group = byName.get(type.name) ?? [];
            group.push(key);
            byName.set(type.name, group);
        }
        const names = new Map<string, string>();
        for (const [name, keys] of byName) {
            for (const key of keys) {
                const type = types.get(key)!;
                const keepsBareName = keys.length === 1 || type.packageName === homePackage;
                names.set(
                    key,
                    keepsBareName ? name : BundledNames.qualified(type.packageName, name),
                );
            }
        }
        return names;
    }

    /** `@myorg/lang-api-dtos` + `X` → `myorg.lang-api-dtos.X` — `^[a-zA-Z0-9.\-_]+$`, as 3.1 requires. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static qualified(packageName: string | undefined, name: string): string {
        const owner = (packageName ?? 'no-package').replace(/^@/, '').replace(/\//g, '.');
        return `${owner}.${name}`.replace(/[^A-Za-z0-9.\-_]/g, '_');
    }
}
