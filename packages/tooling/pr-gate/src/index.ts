// @webpieces/pr-gate — gated PR system.
//
// Public surface is intentionally small for now. The package mainly ships bin
// commands (wp-git-update, wp-git-gather, wp-git-merge-complete, and — added in a
// later phase — wp-upsert-pr / wp-build-affected). Shared library exports (dashboard
// gate computation, etc.) are added as the dashboard lands.

export {
    GateResult,
    DisableCounts,
    DashboardInput,
    computeGateResults,
    countAddedDisables,
    renderDashboard,
} from './dashboard/dashboard';
