import { FieldDef, SchemaShape, BaseRuleConfig } from '@webpieces/rules-sdk';

/**
 * The four `@webpieces/ipc-bridge` guard rules (#1389). They replace a consumer's standalone script that
 * built ONE TypeScript program over every source file of a monorepo (and ran out of memory doing it):
 *
 *   ipc-boundary             — per FILE, syntax only: who may touch raw IPC, the factories and the WebView
 *   ipc-contract-shape       — per FILE, syntax only: the shape of every directional API in the contract lib
 *   ipc-pairing              — per IPC PROJECT SET: every API has a generated client at its sender and exactly
 *                              one registration at its receiver, whose controller extends that same API
 *   ipc-protocol-fingerprint — per IPC PROJECT SET: the recorded wire fingerprint, compared with the branch
 *                              base so an unversioned contract change fails
 *
 * The only type-checked program any of them builds is rooted at the configured `contractPaths` files
 * alone, so memory follows the size of the contract library, never the size of the repo.
 *
 * Every field that names a consumer path or decides what is refused is REQUIRED with no default
 * (`.claude/rules/no-rule-defaults.md`); every glob is workspace-relative (`**` any depth, `*` one segment).
 * A list that may legitimately be empty (no retired modules) is still required, so the choice is visible.
 */

/** Per-file IPC rules judge whole files: the changed ones, every file of a touched project, or all of them. */
export const IPC_FILE_MODES = ['OFF', 'NEW_AND_MODIFIED_FILES', 'MODIFIED_PROJECTS', 'RUN_EVERY_TIME'] as const;

export type IpcFileMode = typeof IPC_FILE_MODES[number];

/**
 * Project-scoped IPC rules judge the configured IPC file set as a whole: whenever a project owning one of
 * those files is touched (MODIFIED_PROJECTS), or on every run (RUN_EVERY_TIME).
 */
export const IPC_PROJECT_MODES = ['OFF', 'MODIFIED_PROJECTS', 'RUN_EVERY_TIME'] as const;

export type IpcProjectMode = typeof IPC_PROJECT_MODES[number];

/** What `ipc-protocol-fingerprint` does when the branch base (merge-base with main) cannot be found. */
export const IPC_WITHOUT_BASELINE = ['FAIL', 'VERIFY_COMMITTED'] as const;

export type IpcWithoutBaseline = typeof IPC_WITHOUT_BASELINE[number];

/**
 * `ipc-boundary` — "nobody else may". Judged one file at a time from that file's syntax tree; an alias is
 * followed only inside the file (`import { IpcClientFactory as F }`, `const alias = webView`).
 *
 * - `tsconfigPath` — the tsconfig whose `paths`/`baseUrl` resolve a non-relative import (read without
 *   enumerating the repo's files).
 * - `transportFiles` — globs of the modules that own raw delivery and `IpcConnection` lifetimes (the shell
 *   transport, a WebView delivery layer). A transport file is ALSO a composition file.
 * - `compositionFiles` — globs of the modules that may build `IpcClientFactory` / `IpcServerFactory`, call
 *   `createClient` / `create` / `createScoped` / `withContext`, and import `@webpieces/ipc-bridge`.
 * - `bootstrapFiles` — globs of the protocol-discovery modules that may send the one raw discovery message.
 * - `testOnlyModuleSuffixes` — module specifier suffixes (e.g. `.spec-support`) production code may not import.
 * - `retiredModules` — module specifiers nobody may import or `require` (a retired vendor bus).
 * - `retiredIdentifiers` — identifiers nobody may write (a retired raw request helper).
 * - `forbiddenClassNamePatterns` — regular expressions a class name may not match (handwritten wire clients).
 * - `legacyWireFile` — the file declaring the legacy raw wire constants, whose exported constants transport
 *   and bootstrap files may not import; `null` when there is none.
 * - `bootstrapAllowedLegacyNames` — the legacy constants a bootstrap file MAY import (the discovery message).
 * - `legacyWireCommandPrefixes` — string-literal prefixes of legacy feature wire commands that transport and
 *   bootstrap files may not author.
 */
export class IpcBoundaryConfig extends BaseRuleConfig {
    declare mode?: IpcFileMode;
    tsconfigPath!: string;
    transportFiles!: string[];
    compositionFiles!: string[];
    bootstrapFiles!: string[];
    testOnlyModuleSuffixes!: string[];
    retiredModules!: string[];
    retiredIdentifiers!: string[];
    forbiddenClassNamePatterns!: string[];
    legacyWireFile!: string | null;
    bootstrapAllowedLegacyNames!: string[];
    legacyWireCommandPrefixes!: string[];

    static readonly SCHEMA: SchemaShape<IpcBoundaryConfig> = {
        mode: new FieldDef('string', IPC_FILE_MODES),
        tsconfigPath: new FieldDef('string'),
        transportFiles: FieldDef.nonEmptyStrings('Name the module(s) that own raw IPC delivery.'),
        compositionFiles: FieldDef.nonEmptyStrings('Name the module(s) that create IPC clients and register receivers.'),
        bootstrapFiles: new FieldDef('string[]'),
        testOnlyModuleSuffixes: new FieldDef('string[]'),
        retiredModules: new FieldDef('string[]'),
        retiredIdentifiers: new FieldDef('string[]'),
        forbiddenClassNamePatterns: new FieldDef('string[]'),
        legacyWireFile: FieldDef.nullableString(),
        bootstrapAllowedLegacyNames: new FieldDef('string[]'),
        legacyWireCommandPrefixes: new FieldDef('string[]'),
    };
}

/**
 * `ipc-contract-shape` — every directional API in the `api:ipc-contract` library, judged one file at a time:
 * class-level `@WpInternal('<id>')`, and on every method `@WpIpcEndpoint('<id>')` (with a literal `kind` when
 * given) plus `@MaskLog(...)`, ONE required parameter typed by a named DTO, an explicit `Promise<…>` return,
 * and unique ids. Contract files may not import host/factory packages or endpoint/runtime code.
 *
 * - `tsconfigPath` — resolves the contract's non-relative imports for `forbiddenImportPaths`.
 * - `contractPaths` — globs of the contract library's source files (the files this rule judges).
 * - `apiClassSuffixes` — class-name suffixes that make a class a directional API (`ToNativeApi`).
 * - `requiredProjectTags` — tags the project owning a contract file must carry (`api:ipc-contract`, …).
 * - `forbiddenImportModules` — globs over a contract import's MODULE SPECIFIER (`@angular/*`, `react`).
 * - `forbiddenImportPaths` — globs over the workspace path a contract import RESOLVES to (`services/**`).
 */
export class IpcContractShapeConfig extends BaseRuleConfig {
    declare mode?: IpcFileMode;
    tsconfigPath!: string;
    contractPaths!: string[];
    apiClassSuffixes!: string[];
    requiredProjectTags!: string[];
    forbiddenImportModules!: string[];
    forbiddenImportPaths!: string[];

    static readonly SCHEMA: SchemaShape<IpcContractShapeConfig> = {
        mode: new FieldDef('string', IPC_FILE_MODES),
        tsconfigPath: new FieldDef('string'),
        contractPaths: FieldDef.nonEmptyStrings('Name the contract library source globs.'),
        apiClassSuffixes: FieldDef.nonEmptyStrings('Name the class suffixes of directional APIs, e.g. ToNativeApi.'),
        requiredProjectTags: new FieldDef('string[]'),
        forbiddenImportModules: new FieldDef('string[]'),
        forbiddenImportPaths: new FieldDef('string[]'),
    };
}

/** One direction of the bridge: which APIs travel it, who sends, who receives. Data-only. */
export class IpcDirectionEntry {
    /** Class-name suffix of the APIs in this direction, e.g. `ToNativeApi`. */
    apiSuffix!: string;
    /** The `direction` value the wire table carries for these APIs, e.g. `native`. */
    wireDirection!: string;
    /** Globs of the sending endpoint's files; one of them must hold `createClient(<Api>)`. */
    senderFiles!: string[];
    /** Globs of the receiving endpoint's files; exactly one `create`/`createScoped(<Api>, …)` lives here. */
    receiverFiles!: string[];

    static readonly SCHEMA: SchemaShape<IpcDirectionEntry> = {
        apiSuffix: new FieldDef('string'),
        wireDirection: new FieldDef('string'),
        senderFiles: FieldDef.nonEmptyStrings(),
        receiverFiles: FieldDef.nonEmptyStrings(),
    };
}

/**
 * `ipc-pairing` — every directional API has a generated client at its sending endpoint and exactly ONE
 * framework registration at its receiver, whose controller is a subclass of that same shared abstract API;
 * no handwritten dispatch map sits beside the factory. With a wire table configured, every table row names
 * a real API method, wires are unique, kinds/since/direction are sane and agree with the decorators.
 *
 * The contract side is read through a type-checked program rooted at `contractPaths` ONLY; the endpoint
 * side is read syntactically from `senderFiles` / `receiverFiles` and the files their controllers come from.
 *
 * - `tsconfigPath`, `contractPaths` — as for `ipc-contract-shape`.
 * - `directions` — one entry per direction of the bridge (see {@link IpcDirectionEntry}).
 * - `wireTableFile` / `wireTableExport` — the file and exported const of a literal wire table
 *   (`[{ api, method, wire, direction, kind, since }]`); both `null` when the contract has none.
 * - `forbiddenDispatchVariables` — variable names a receiver file may not initialise with `new …`
 *   (the handwritten dispatch map the factory replaced).
 */
export class IpcPairingConfig extends BaseRuleConfig {
    declare mode?: IpcProjectMode;
    tsconfigPath!: string;
    contractPaths!: string[];
    directions!: IpcDirectionEntry[];
    wireTableFile!: string | null;
    wireTableExport!: string | null;
    forbiddenDispatchVariables!: string[];

    static readonly SCHEMA: SchemaShape<IpcPairingConfig> = {
        mode: new FieldDef('string', IPC_PROJECT_MODES),
        tsconfigPath: new FieldDef('string'),
        contractPaths: FieldDef.nonEmptyStrings('Name the contract library source globs.'),
        directions: FieldDef.nonEmptyObjects(IpcDirectionEntry.SCHEMA),
        wireTableFile: FieldDef.nullableString(),
        wireTableExport: FieldDef.nullableString(),
        forbiddenDispatchVariables: new FieldDef('string[]'),
    };
}

/**
 * `ipc-protocol-fingerprint` — `manifestPath` records `{ protocol, fingerprint }`: a sha256 over every API /
 * method id, kind, wire row (direction, since), the fully resolved request and reply shapes, and the
 * comment-free printed source of `normalizedSourceFiles` (decorators, masks, validators). The rule fails
 * when the committed manifest does not match the source, when the protocol decreased relative to the branch
 * base, or when the fingerprint changed relative to the branch base without a protocol increment — so
 * re-recording the manifest alone cannot hide an unversioned wire change. Re-record with
 * `pnpm wp-ipc-record-protocol` after incrementing the version constant.
 *
 * - `tsconfigPath`, `contractPaths`, `apiClassSuffixes`, `wireTableFile`, `wireTableExport` — as above.
 * - `normalizedSourceFiles` — globs, hashed in the order listed (files matching one glob sorted by path).
 * - `manifestPath` — the committed manifest, workspace-relative.
 * - `versionFile` / `versionConstant` — where the protocol integer is declared (`export const X = 18;`).
 * - `withoutBaseline` — FAIL (an ordinary clone with no reachable main) or VERIFY_COMMITTED (an archive or
 *   shallow build checkout: still verify the manifest against the source, skip the increment check).
 */
export class IpcProtocolFingerprintConfig extends BaseRuleConfig {
    declare mode?: IpcProjectMode;
    tsconfigPath!: string;
    contractPaths!: string[];
    apiClassSuffixes!: string[];
    wireTableFile!: string | null;
    wireTableExport!: string | null;
    normalizedSourceFiles!: string[];
    manifestPath!: string;
    versionFile!: string;
    versionConstant!: string;
    withoutBaseline!: IpcWithoutBaseline;

    static readonly SCHEMA: SchemaShape<IpcProtocolFingerprintConfig> = {
        mode: new FieldDef('string', IPC_PROJECT_MODES),
        tsconfigPath: new FieldDef('string'),
        contractPaths: FieldDef.nonEmptyStrings('Name the contract library source globs.'),
        apiClassSuffixes: FieldDef.nonEmptyStrings('Name the class suffixes of directional APIs, e.g. ToNativeApi.'),
        wireTableFile: FieldDef.nullableString(),
        wireTableExport: FieldDef.nullableString(),
        normalizedSourceFiles: FieldDef.nonEmptyStrings('Name the contract/mask/validator sources to hash.'),
        manifestPath: new FieldDef('string'),
        versionFile: new FieldDef('string'),
        versionConstant: new FieldDef('string'),
        withoutBaseline: new FieldDef('string', IPC_WITHOUT_BASELINE),
    };
}
