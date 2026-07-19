export { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';
export { InformAiError } from './inform-ai-error';
export { RuleFailError } from './rule-fail-error';
export { CliExitError } from './cli-exit-error';
export { runMain } from './run-main';
export { toError } from './to-error';
export { loadAndValidate, LoadedConfig, ConfigLoader } from './load-config';
export { findConfigFile, CONFIG_FILENAME, ConfigFile } from './config-file';
export { RepoRootFinder, INSTRUCT_AI_DIR } from './repo-root';
export { RulesConfigDesign } from './rules-config-design';
export { DocumentDesign, isDocumentDesign, DESIGN_METADATA_KEYS } from './di';
export { ExcludePaths } from './exclude-hook-paths';
export { isPathExcluded } from './exclude-paths';
export { defaultRules, defaultRulesDir } from './default-rules';
export { loadTemplate, writeTemplateIfMissing, writeTemplate, TemplateWriter } from './load-template';
export { validateWebpiecesConfig, validatePrGateSection, validateSectionPlacement, validateCommandsSection, validateExcludePaths, validateMatchRulesSection, allRuleNames } from './validate-config';
export {
    MatchRuleConfig,
    MatchRuleViolation,
    findMatchRuleViolations,
    isMatchRuleAllowedPath,
    compileMatchRulePatterns,
    renderMatchRuleMessage,
    DEFAULT_MATCH_RULES,
} from './match-rules-config';
export type { ConfigSection } from './sections';
export { HOOK_GUARD_NAMES, isHookGuard, sectionForRule } from './sections';
export { FieldDef } from './field-def';
export type { SchemaShape } from './field-def';
export { shouldSkipRule, getCurrentBranch } from './skip-rule';
export type { SkipRuleResult } from './skip-rule';
export {
    detectBase,
    resolveBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
    findNewMethodSignaturesInDiff,
    hasChangesInRange,
    isNewOrModified,
    DiffScope,
    DiffRange,
    ChangedFilesOptions,
} from './diff-scope';
export { AbstractRule } from './abstract-rule';
export {
    WEBPIECES_DISABLE,
    RULE_NAMES,
    hasDisable,
    WEBPIECES_TMP_DIR,
    MERGE_INFO_DIR,
    PR_REVIEW_DIR,
    MERGE_IN_PROGRESS_FILE,
    MERGE_EXPLANATION_FILE,
} from './constants';
export { WebpiecesRulesConfig } from './WebpiecesRulesConfig';
export {
    MaxMethodLinesConfig,
    MaxFileLinesConfig,
    RequireReturnTypeConfig,
    NoInlineTypeLiteralsConfig,
    NoAnyUnknownConfig,
    NoImplicitAnyConfig,
    PrismaValidateDtosConfig,
    PrismaConverterConfig,
    NoDestructureConfig,
    NoUnmanagedExceptionsConfig,
    CatchErrorPatternConfig,
    ThrowCauseRequiredConfig,
    AngularNoDirectApiInResolverConfig,
    NoSymbolDiTokensConfig,
    NoCustomCssConfig,
    NoProcessExitOutsideMainConfig,
    NoFunctionOutsideClassConfig,
    InjectAnnotationNotNeededForConcreteClassConfig,
    FrameworkTagConfig,
    RoleTagConfig,
    BranchCreationGuardConfig,
    PrCreationOrPushGuardConfig,
    MergeInProgressGuardConfig,
    PrMergeGuardConfig,
    RedirectHowToMergeMainConfig,
    FeatureBranchGuardConfig,
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NxWiringConfig,
    DiGraphConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
    BaseRuleConfig,
} from './rule-configs';
// Mode unions + their value arrays — the single source of truth shared with code-rules.
export {
    METHOD_LIMIT_MODES,
    FILE_LIMIT_MODES,
    RETURN_TYPE_MODES,
    INLINE_TYPE_MODES,
    MODIFIED_CODE_MODES,
    PROJECT_MODES,
    PRISMA_DTOS_MODES,
    PRISMA_CONVERTER_MODES,
    DIRECT_API_RESOLVER_MODES,
    THROW_CAUSE_MODES,
    ON_OFF_MODES,
    STRUCTURAL_MODES,
    VALIDATE_TS_MODES,
} from './rule-configs';
export type {
    MethodLimitMode,
    FileLimitMode,
    ReturnTypeMode,
    InlineTypeMode,
    ModifiedCodeMode,
    ProjectMode,
    PrismaValidateDtosMode,
    PrismaConverterMode,
    DirectApiResolverMode,
    ThrowCauseMode,
    OnOffMode,
    StructuralMode,
    ValidateTsMode,
} from './rule-configs';
export {
    GateDefinition,
    PrGateConfig,
    defaultGates,
    defaultPrGateConfig,
    buildPrGateConfig,
} from './pr-gate-config';
export {
    ReviewJson,
    ReviewJsonService,
    loadReviewJson,
    prDirFor,
    reviewJsonPath,
    reviewJsonSchemaHint,
} from './review-json';
export {
    MainSyncStatus,
    MainSyncLock,
    MainSyncStatusService,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    mainSyncStatusPath,
    mainSyncLockPath,
    readMainSyncStatus,
    writeMainSyncStatus,
    readMainSyncLock,
    writeMainSyncLock,
    isLockStale,
    isRefreshInProgress,
    inProcessLock,
    finishedLock,
    computeMainSyncStatus,
    stampCleanMainSyncStatus,
    squashRecoverySteps,
} from './main-sync-status';
export {
    MergedBranch,
    DeletableBranch,
    DeletableWorktree,
    MergedBranchesCache,
    MergedBranchesService,
} from './merged-branches';
export {
    Worktree,
    WorktreeService,
} from './worktrees';
export type { MutationVerb, MutationPhase } from './branch-mutation-log';
export {
    BranchMutationEvent,
    BranchMutationLog,
    branchMutationLogPath,
    logBranchMutation,
} from './branch-mutation-log';
export {
    CommandsConfig,
    buildCommandsConfig,
    DEFAULT_UPSERT_PR_COMMAND,
    DEFAULT_MERGE_COMPLETE_COMMAND,
} from './commands-config';
