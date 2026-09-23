// @webpieces/pr-gate — gated PR system.
//
// Now published to npm via the release workflow (OIDC trusted publishing).
// Public surface is intentionally small for now. The package mainly ships bin
// commands (wp-start-update, wp-finish-update, wp-finish-upsert-pr, wp-start-upsert-pr).
// The build gate and 3-point merge-info gathering are internal `workflow/` library functions
// (BuildAffected.runBuildGate, gatherInfo), not bins. Shared library exports (dashboard gate
// computation, etc.) back the dashboard those commands render.
//
// `runBuildGate` is the ONLY way to run a build — the `runBuildAffected` / `runConfiguredBuildGate`
// side doors it used to sit beside are gone, folded into one private spawn, because each of them
// executed `buildCommand` with no caller identity and no `~/.webpieces/builds.log` row. One spelling,
// and an unlogged build no longer compiles.

export {
    GateResult,
    DisableCounts,
    ChecklistRow,
    DashboardInput,
    Dashboard,
    DETAIL_COMMENT_MARKER,
} from './dashboard/dashboard';
// The 2nd PR comment's renderer — its own surface, its own class. A barrel is the surface too, so this
// is exported alongside Dashboard rather than left reachable only by deep import.
export {
    ChecklistCommentRenderer,
    CHECKLIST_COMMENT_MARKER,
} from './dashboard/checklist-comment-renderer';
export { PrCommentUpserter, PrCommentRequest, PrCommentResult } from './scripts/workflow/pr-comment-upserter';
// Pins the two server-side GitHub settings the git-log body depends on. Exported because a consumer may
// want to assert them in its own CI — they are the one part of this design no config can express.
export {
    SquashSettingsEnforcer, SquashSettings, SQUASH_TITLE_REQUIRED, SQUASH_MESSAGE_REQUIRED,
} from './scripts/workflow/squash-settings-enforcer';
export { ChecklistDetector, TriggeredChecklist } from './scripts/workflow/checklist-detector';
export { PrGateApp } from './scripts/pr-gate-app';
// The generated-contract surface (#986). The nx `openapi-generate` / `docs-generate` executors resolve
// their generator through ConsumerBinResolver — the consumer's own install, never a bundled copy — and
// the PR gate's 3rd comment is the partner-facing contract diff, merge-base → HEAD.
export {
    ConsumerBinResolver, ConsumerBinRequest, ConsumerBin,
} from './scripts/workflow/contract/consumer-bin-resolver';
export { GeneratorRunner, GeneratorRun } from './scripts/workflow/contract/generator-runner';
export {
    GeneratorPackage, OPENAPI_GENERATOR, DOCS_SITE, OPENAPI_GENERATE_EXECUTOR, PARTNER_DOCUMENT,
} from './scripts/workflow/contract/generator-package';
export { OpenApiContractDiff, ContractChange } from './scripts/workflow/contract/openapi-contract-diff';
export type { ContractChangeKind } from './scripts/workflow/contract/openapi-contract-diff';
export {
    ContractDiffRenderer, ContractDiffSection, CONTRACT_DIFF_COMMENT_MARKER,
} from './scripts/workflow/contract/contract-diff-renderer';
export { ContractDiffStep, DeclaredContract } from './scripts/workflow/contract/contract-diff-step';
export type { JsonValue, JsonObject } from './scripts/workflow/contract/json-value';
