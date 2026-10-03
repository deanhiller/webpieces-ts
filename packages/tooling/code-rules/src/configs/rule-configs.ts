import { FileLimitMode, FILE_LIMIT_MODES, ModifiedCodeMode, MODIFIED_CODE_MODES } from "@webpieces/rules-sdk";
import { BaseRuleConfig, BASE_RULE_SCHEMA } from "@webpieces/rules-sdk";
import { FieldDef, SchemaShape } from "@webpieces/rules-sdk";
// Mode const arrays — TypeScript union types derived from them, and FieldDef enum
// values reference the same array. Impossible for the type and runtime check to diverge.

// Single source of truth for rule "mode" values. Exported so code-rules (and any other
// consumer) imports these instead of re-declaring the same unions — a rename here ripples
// everywhere at compile time. The FieldDef SCHEMA below references the same arrays, so the
// type and the runtime validation can never diverge.
export const METHOD_LIMIT_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;

export type MethodLimitMode = typeof METHOD_LIMIT_MODES[number];

export const RETURN_TYPE_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;

export type ReturnTypeMode = typeof RETURN_TYPE_MODES[number];

export const INLINE_TYPE_MODES = ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;

export type InlineTypeMode = typeof INLINE_TYPE_MODES[number];

// PROJECT-level rules (e.g. framework-tag): the check is neither line- nor file-scoped — it runs
// for a whole project when ANY file the project owns is touched. `MODIFIED_PROJECTS` names that
// honestly (nx `affected` already narrows execution to the changed projects).
export const PROJECT_MODES = ['OFF', 'MODIFIED_PROJECTS'] as const;

export type ProjectMode = typeof PROJECT_MODES[number];

export const PRISMA_DTOS_MODES = ['OFF', 'MODIFIED_CLASS', 'NEW_AND_MODIFIED_FILES'] as const;

export type PrismaValidateDtosMode = typeof PRISMA_DTOS_MODES[number];

export const PRISMA_CONVERTER_MODES = ['OFF', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;

export type PrismaConverterMode = typeof PRISMA_CONVERTER_MODES[number];

export const DIRECT_API_RESOLVER_MODES = ['OFF', 'NEW_AND_MODIFIED_CODE', 'NEW_AND_MODIFIED_METHODS', 'NEW_AND_MODIFIED_FILES'] as const;

export type DirectApiResolverMode = typeof DIRECT_API_RESOLVER_MODES[number];

// ---------------------------------------------------------------------------
// Universal escape hatches — EVERY rule supports temporarily disabling itself
// either while on a named git branch (turnOffRuleWhileOnBranch) or until an
// epoch passes (turnOffRuleUntilEpoch). They live on a shared base class so the
// fields (and their schema entries) are declared once instead of repeated per
// rule. `mode` stays per-rule because its allowed values vary (ON/OFF vs
// NEW_AND_MODIFIED_CODE vs NEW_AND_MODIFIED_METHODS, etc).
//
// BOTH fields are REQUIRED on every rule so both hatches are ALWAYS VISIBLE in the config — an AI
// editing webpieces.config.json sees them on every rule and cannot miss that a rule can be time-boxed
// or branch-scoped off. Convention:
//   turnOffRuleUntilEpoch:    0 = rule active (epoch in the past); a future unix epoch IN SECONDS =
//                             temporarily disabled until that moment.
//   turnOffRuleWhileOnBranch: null = always on; a branch name = disabled while that branch is checked out.
//                             The name is matched EXACTLY (===). Globs/wildcards are NOT supported and
//                             must not be added: a pattern would switch a rule off on branches nobody
//                             enumerated. It is also ignored (loudly — shouldSkipRule throws) on a pull
//                             request from a FORK, where the branch name is the contributor's to choose.
//                             Required-but-nullable so its "unset" state is present-and-visible (null)
//                             rather than omitted.
// The earlier spellings of these two fields were RENAMED to the names above and are no longer accepted —
// the validator rejects them with a "renamed to X" hint. RENAMED_FIELD_ALIASES in validate-config.ts is
// the ONE place in src/ a dead spelling may still be written (see escape-hatch-key-spelling.spec.ts).
// ---------------------------------------------------------------------------
export class MaxMethodLinesConfig extends BaseRuleConfig {
    declare mode?: MethodLimitMode;
    limit?: number;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<MaxMethodLinesConfig> = {
        mode: new FieldDef('string', METHOD_LIMIT_MODES),
        limit: FieldDef.optional('number'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

// max-file-lines — caps a file's line count.
//
// `allowedPaths` exempts whole file trees, matched with the shared `isPathExcluded` glob/prefix/segment
// semantics (the same field, same matcher and same meaning as no-function-outside-class / no-js-files /
// no-destructure). It is for files the repo did NOT author and cannot shrink — never a standing amnesty
// for hand-written code, which is what the inline disable and a refactor are for.
//
// The machine-generated trees in GENERATED_CODE_PATHS are exempt WITHOUT configuration, and
// `allowedPaths` ADDS to that floor rather than replacing it — see generated-code-paths.ts for why a
// 42,000-line graphql-codegen output must not be able to cost a repo the whole rule.
export class MaxFileLinesConfig extends BaseRuleConfig {
    declare mode?: FileLimitMode;
    limit?: number;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<MaxFileLinesConfig> = {
        mode: new FieldDef('string', FILE_LIMIT_MODES),
        limit: FieldDef.optional('number'),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class RequireReturnTypeConfig extends BaseRuleConfig {
    declare mode?: ReturnTypeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<RequireReturnTypeConfig> = {
        mode: new FieldDef('string', RETURN_TYPE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoInlineTypeLiteralsConfig extends BaseRuleConfig {
    declare mode?: InlineTypeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoInlineTypeLiteralsConfig> = {
        mode: new FieldDef('string', INLINE_TYPE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoAnyUnknownConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoAnyUnknownConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoImplicitAnyConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoImplicitAnyConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrismaValidateDtosConfig extends BaseRuleConfig {
    declare mode?: PrismaValidateDtosMode;
    disableAllowed?: boolean;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];

    static readonly SCHEMA: SchemaShape<PrismaValidateDtosConfig> = {
        mode: new FieldDef('string', PRISMA_DTOS_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        prismaSchemaPath: FieldDef.optional('string'),
        dtoSourcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class PrismaConverterConfig extends BaseRuleConfig {
    declare mode?: PrismaConverterMode;
    disableAllowed?: boolean;
    schemaPath?: string;
    convertersPaths?: string[];
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<PrismaConverterConfig> = {
        mode: new FieldDef('string', PRISMA_CONVERTER_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        schemaPath: FieldDef.optional('string'),
        convertersPaths: FieldDef.optional('string[]'),
        enforcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// `allowedPaths` exempts whole file trees whose idioms are destructuring by construction (React /
// React Native components and hooks — `const [x, setX] = useState()`, destructured props — framework
// glue), matched with the shared glob/prefix/segment semantics of `isPathExcluded`. It is the ONLY
// escape when `disableAllowed: false`, since that setting deliberately ignores inline disables.
export class NoDestructureConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    allowTopLevel?: boolean;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoDestructureConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowTopLevel: FieldDef.optional('boolean'),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoUnmanagedExceptionsConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoUnmanagedExceptionsConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class CatchErrorPatternConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<CatchErrorPatternConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class AngularNoDirectApiInResolverConfig extends BaseRuleConfig {
    declare mode?: DirectApiResolverMode;
    disableAllowed?: boolean;
    enforcePaths?: string[];

    static readonly SCHEMA: SchemaShape<AngularNoDirectApiInResolverConfig> = {
        mode: new FieldDef('string', DIRECT_API_RESOLVER_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        enforcePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// Bans hand-written CSS in Angular sources (styles:/styleUrls:/styleUrl: in @Component, and inline
// style=/[style.x]/[ngStyle] in templates) so teams style with Tailwind utility classes. `allowGlobs`
// exempts paths WITHIN the Angular scope (e.g. a vendored Fuse kit copied verbatim with its own CSS).
export class NoCustomCssConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowGlobs?: string[];

    static readonly SCHEMA: SchemaShape<NoCustomCssConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowGlobs: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoSymbolDiTokensConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoSymbolDiTokensConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// Flags `process.exit(...)` outside a main()/runMain wrapper (and `import { main }`) so a deep exit
// can't silently kill a reused server/command. Gradual-rollout knobs via the standard base: mode
// (OFF | NEW_AND_MODIFIED_CODE | NEW_AND_MODIFIED_FILES), turnOffRuleUntilEpoch, branch, and
// disableAllowed for the inline `// webpieces-disable` escape at genuine terminal boundaries.
export class NoProcessExitOutsideMainConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoProcessExitOutsideMainConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

// Flags a function CREATED OUTSIDE A CLASS at module scope: a top-level `function foo()` declaration
// or a top-level `const foo = () => {}` / `= function(){}`. The point is that webpieces DI +
// @DocumentDesign only work when behavior lives in injectable classes — a module-scope function is a
// dead-end the DI graph can't reach. Inline callbacks, nested functions inside methods, and non-function
// top-level consts (objects, zod schemas, primitives) are NOT flagged. Standard rollout knobs via the
// base: mode (OFF | NEW_AND_MODIFIED_CODE | NEW_AND_MODIFIED_FILES), turnOffRuleUntilEpoch, branch,
// and disableAllowed for the inline `// webpieces-disable` escape. `allowedPaths` exempts whole file
// trees that legitimately live outside the class-per-behavior model (e.g. React component/hook files,
// framework glue), matched with the shared glob/prefix/segment semantics of `isPathExcluded`.
export class NoFunctionOutsideClassConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoFunctionOutsideClassConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// inject-annotation-not-needed-for-concrete-class — flags a REDUNDANT `@inject(X)` whose token is
// textually identical to the parameter's own declared type (`@inject(Foo) private readonly foo: Foo`).
// In this inversify setup the decorator is pure noise there: reflect-metadata (emitDecoratorMetadata)
// already resolves a constructor parameter by its class type, so `private readonly foo: Foo` binds on
// its own (see CLAUDE.md, and the no-symbol-di-tokens rule that pushes the same way). Symbol/interface
// tokens are NOT flagged because they never equal the type (`@inject(FOO_TOKEN) x: Provider<Foo>`).
// AI keeps carpet-bombing `@inject`; this fails the build on the redundant form. Standard rollout knobs
// via the base: mode (OFF | NEW_AND_MODIFIED_CODE | NEW_AND_MODIFIED_FILES), turnOffRuleUntilEpoch,
// branch, and disableAllowed for the inline `// webpieces-disable` escape. `allowedPaths` exempts whole
// file trees, matched with the shared glob/prefix/segment semantics.
export class InjectAnnotationNotNeededForConcreteClassConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<InjectAnnotationNotNeededForConcreteClassConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// framework-tag — every project that a changed source file belongs to must carry >=1
// `framework:<browser|react|angular|node|express|react-native>` nx tag in its project.json. Those tags are the
// project's "libType" — the SET of runtime environments it runs in — and the source of truth for
// the dependencies.json `framework` field and the `library-types-match-client` rule. Multiple tags
// are allowed (the env set) and values are validated against the known set (`framework:all` is a
// hard error). `knownTypes` customizes that set (defaults to browser, react, angular, node, express,
// react-native — the last a first-class runtime, not a browser, #1064).
export class FrameworkTagConfig extends BaseRuleConfig {
    declare mode?: ProjectMode;
    knownTypes?: string[];

    static readonly SCHEMA: SchemaShape<FrameworkTagConfig> = {
        mode: new FieldDef('string', PROJECT_MODES),
        knownTypes: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// role-tag — every project that a changed source file belongs to must carry a
// `role:<server|app|bundle|designed-lib|lib|client|api-lib|api-client>` nx tag in its project.json. That tag is the project's
// ROLE (orthogonal to `framework` libType) — the source of truth for the dependencies.json `role`
// field, the `role-dependency` edge rule (apps are never depended upon), and DI-design generation
// (server→@Controller, designed-lib→@ApiImplementation, lib→none, client→angular design).
// `knownTypes` customizes the list suggested to the author when a tag is missing.
export class RoleTagConfig extends BaseRuleConfig {
    declare mode?: ProjectMode;
    knownTypes?: string[];

    static readonly SCHEMA: SchemaShape<RoleTagConfig> = {
        mode: new FieldDef('string', PROJECT_MODES),
        knownTypes: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

// Touching a project audits every production API contract it directly owns.
export class EnsureWeAreSecureConfig extends BaseRuleConfig {
    declare mode?: ProjectMode;
    static readonly SCHEMA: SchemaShape<EnsureWeAreSecureConfig> = {
        mode: new FieldDef('string', PROJECT_MODES),
        ...BASE_RULE_SCHEMA,
    };
}
