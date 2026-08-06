export { ResolvedConfig, ResolvedRuleConfig, RuleOptions } from './types';
export { InformAiError } from './inform-ai-error';
export { RuleFailError } from './rule-fail-error';
export { CliExitError } from './cli-exit-error';
export { CliUsage, CliFlag, CliArgSet, CliArgsCheck, CliArgs } from './cli-args';
export { runMain } from './run-main';
export { toError } from './to-error';
export { loadAndValidate, LoadedConfig, ConfigLoader } from './load-config';
// The validation-failure banner: ONE cure (edit the file), plus the marker phrases the validator
// messages embed rather than re-type.
export {
    formatConfigErrorsBanner,
    RETIRED_KEY_MARKER,
    RETIRED_TOP_LEVEL_MARKER,
    SECTION_PLACEMENT_MARKER,
} from './config-error-banner';
export { findConfigFile, CONFIG_FILENAME, ConfigFile, ConfigParseAttempt, CONFIG_PARSE_ATTEMPTS, CONFIG_PARSE_RETRY_MILLIS } from './config-file';
export { RepoRootFinder, INSTRUCT_AI_DIR, INSTRUCT_AI_LEAF } from './repo-root';
// The scoped `.webpieces` resolver. EVERY reader/writer of `.webpieces/...` goes through one of its two
// named methods so the call site declares whether the state is repo-wide or worktree-private.
export { DotWebpieces, dotWebpieces, GitDirs, agentDirName, WORKTREE_STATE_DIR, LOGS_STATE_DIR, HOOKS_STATE_DIR, AGENTS_STATE_DIR } from './state-dir';
export { StateDirMigrator, StateMigrationReport } from './state-dir-migration';
export { ClaudeEnv, claudeEnv, CLAUDE_PROJECT_DIR_ENV, CLAUDE_PROJECT_DIR_UNSET } from './claude-env';
export { AtomicFile } from './atomic-file';
// The ONE formatter for a remedy that must run in a named directory: `cd '<root>' && <command>`.
// Single-quoted so a repo path containing a space is still runnable (and still un-smuggleable).
export { atRoot } from './at-root';
export { RulesConfigDesign } from './rules-config-design';
export { DocumentDesign, isDocumentDesign, DESIGN_METADATA_KEYS } from './di';
export { ExcludePaths } from './exclude-hook-paths';
export { isPathExcluded, matchesAnyGlob } from './exclude-paths';
export { defaultRules, defaultRulesDir } from './default-rules';
export { loadTemplate, writeTemplateIfMissing, writeTemplate, TemplateWriter } from './load-template';
export { validateWebpiecesConfig, validatePrGateSection, validateChecklistsSection, validateSectionPlacement, validateExcludePaths, validateMatchRulesSection, allRuleNames, recommendedSeedMode, recommendedSeedModeFor, seedEntryForRule } from './validate-config';
export { validateCommandsSection } from './commands-section-validators';
export { unknownKeyErrors, isCommentKey, validateTopLevelKeys, COMMENT_KEY_SUFFIX } from './config-key-rules';
// The retired-key table + the no-back-compat policy it enforces. Exported so the installer can migrate
// what the errors instruct, and so consumers can enumerate retirements.
export { RETIRED_CONFIG_KEYS, RETIRED_SCOPE_KEY, RETIRED_SCOPE_RULE, RetiredConfigKey, isRetiredKey, retiredEntry, retiredKeyError, retiredKeyErrorsIn, retiredRuleFor } from './retired-config-keys';
export { validateChecklistDocs } from './checklist-docs-validator';
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
    PUSH_DEV_STATE_FILE,
} from './constants';
export { WebpiecesRulesConfig } from './WebpiecesRulesConfig';
export {
    SyncFlowGuidance,
    WP_START_UPDATE,
    WP_FINISH_UPDATE,
    WP_START_UPSERT_PR,
    WP_FINISH_UPSERT_PR,
    WP_PUSH_DEV,
    WP_FINISH_PUSH_DEV,
} from './sync-flow-guidance';
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
    NoFileImportCyclesConfig,
    RuntimeArchitectureConfig,
    NxWiringConfig,
    DiGraphConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
    ValidateArchitectureUnchangedConfig,
    ValidateNoArchitectureCyclesConfig,
    ValidatePackageJsonConfig,
    ValidateVersionsLockedConfig,
    ValidateEslintSyncConfig,
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
export {
    NoClientCreationOutsideServerOrClientConfig,
    CLIENT_CREATION_SEVERITIES,
} from './no-client-creation-config';
export type { ClientCreationSeverity } from './no-client-creation-config';
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
    FeatureBranchGuardConfig,
    ReadStaleGuardConfig,
    MergedBranchBashGuardConfig,
    StaleMainBashGuardConfig,
} from './main-sync-guard-configs';
export {
    GateDefinition,
    PrGateConfig,
    LandPrConfig,
    DevDeployConfig,
    DEFAULT_DEV_BRANCH_NAMESPACE,
    DEFAULT_DEV_BRANCH,
    ReviewContextEntry,
    defaultGates,
    defaultPrGateConfig,
    defaultLandPrConfig,
    defaultDevDeployConfig,
    buildPrGateConfig,
    buildLandPrConfig,
    buildDevDeployConfig,
    MERGE_MODE_AUTO,
    MERGE_MODE_NONE,
    MERGE_MODES,
} from './pr-gate-config';
export {
    ChecklistDefinition,
    toChecklist,
    normalizeChecklistDoc,
    formatFileList,
} from './checklist-config';
export type { RawChecklistItem } from './checklist-config';
export { ChecklistValidator } from './checklist-validator';
export { ChecklistInstructionsService } from './checklist-instructions';
export {
    ReviewerInstructionsService,
    ReviewerBriefing,
    BriefedFile,
    ContextEntry,
    READ_TRUNCATION_LINES,
    ALL_DIFF_ONE_READ_LINES,
} from './reviewer-instructions';
export {
    GateTokenService,
    computeGateToken,
    gateTokenMarker,
    extractGateToken,
    verifyGateToken,
} from './gate-token';
export {
    SubagentProvenanceService,
    ReviewerEvidence,
    EvidenceRequest,
    TranscriptScan,
    ProvenanceResult,
    PROVENANCE_OK,
    PROVENANCE_MISSING,
    PROVENANCE_SKIPPED,
} from './subagent-provenance';
export {
    ReviewProvenanceService,
    ReviewProvenance,
    ReviewerTranscript,
    ReviewerPaths,
    OfferedContext,
    ProvenanceWriteRequest,
    DEFAULT_RETENTION_DAYS,
} from './review-provenance';
export {
    ReviewJson,
    PrContext,
    ChecklistResult,
    ChecklistVerdict,
    CK_PASS,
    CK_WARN,
    CK_OVERRIDDEN,
    CK_FAIL,
    CK_MISSING,
    CK_BAD_FORMAT,
    VERDICT_GREEN,
    VERDICT_YELLOW,
    VERDICT_RED,
    VERDICT_STATUSES,
    RequiredChecklist,
    ChecklistReviewContext,
    ReviewJsonService,
    loadReviewJson,
    prDirFor,
    reviewJsonPath,
    reviewJsonSchemaHint,
} from './review-json';
export {
    MainSyncStatus,
    MainSyncStatusFile,
    MainSyncFileStore,
    PullRequestIndex,
    MAIN_SYNC_STATUS_VERSION,
} from './main-sync-file';
export {
    MainSyncLock,
    MainSyncStatusService,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    mainSyncStatusPath,
    mainSyncLockPath,
    readMainSyncStatus,
    readMainSyncStatusFile,
    writeMainSyncStatus,
    writeMainSyncStatusFile,
    computeAllMainSyncStatuses,
    readMainSyncLock,
    writeMainSyncLock,
    isLockStale,
    isRefreshInProgress,
    tryAcquireMainSyncLock,
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
    CacheFreshness,
    CACHE_STALE_AFTER_MS,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_BACKUP_OF_MERGED,
    CLASSIFICATION_BACKUP_OF_LIVE,
    CLASSIFICATION_NO_COMMITS,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_IN_USE,
    CLASSIFICATION_PRUNABLE,
    CLASSIFICATION_LOCKED,
    CLASSIFICATION_CURRENT,
    CLASSIFICATION_DETACHED,
    PROMPTABLE_CLASSIFICATIONS,
} from './merged-branches';
export {
    BranchArchiver,
    ArchiveResult,
    ARCHIVE_TAG_PREFIX,
    BRANCH_RETENTIONS,
    BRANCH_RETENTION_DELETE,
    BRANCH_RETENTION_ARCHIVE_TAG,
    BRANCH_RETENTION_KEEP,
} from './branch-archiver';
export {
    Worktree,
    WorktreeService,
} from './worktrees';
export {
    ReapedBranch,
    ReapResult,
    BranchReaper,
} from './branch-reaper';
export {
    ReapedWorktree,
    WorktreeReapResult,
    WorktreeReaper,
} from './worktree-reaper';
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
