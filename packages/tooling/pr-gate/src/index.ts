// @webpieces/pr-gate — gated PR system.
//
// Now published to npm via the release workflow (OIDC trusted publishing).
// Public surface is intentionally small for now. The package mainly ships bin
// commands (wp-start-update, wp-finish-update, wp-finish-upsert-pr, wp-start-upsert-pr).
// The build gate and 3-point merge-info gathering are internal `workflow/` library functions
// (runBuildAffected, gatherInfo), not bins. Shared library exports (dashboard gate computation,
// etc.) back the dashboard those commands render.

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
