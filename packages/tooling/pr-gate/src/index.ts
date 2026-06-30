// @webpieces/pr-gate — gated PR system.
//
// Now published to npm via the release workflow (OIDC trusted publishing).
// Public surface is intentionally small for now. The package mainly ships bin
// commands (wp-git-update, wp-git-gather, wp-finish-upsert-pr, wp-start-upsert-pr,
// wp-build-affected). Shared library exports (dashboard gate computation, etc.) back
// the dashboard those commands render.

export {
    GateResult,
    DisableCounts,
    DashboardInput,
    computeGateResults,
    countAddedDisables,
    renderDashboard,
} from './dashboard/dashboard';
