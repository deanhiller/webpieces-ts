import { BRANCH_RETENTION_ARCHIVE_TAG, BRANCH_RETENTIONS } from './branch-archiver';
import { ChecklistDefinition, RawChecklistItem, toChecklist } from './checklist-config';

// PrGateConfig is the "special section" for the pr-gate dashboard. It does NOT live in the
// validated `rules` map (the FieldDef schema can't express nested object arrays), but as a
// top-level `pr-gate` key in webpieces.config.json. It is built and validated by
// loadAndValidate (load-config.ts); this module holds only the data classes + defaults + toGate.

export class GateDefinition {
    name: string;
    patterns: string[];
    // The warning color shown on the dashboard WHEN this gate's patterns match a changed file. Green
    // is implicit (shown when nothing matched), so it is never configured. warningColor is purely
    // visual — even 'red' never fails/blocks the PR (only the build gate can). 'yellow' = caution,
    // 'red' = louder "look here" flag (e.g. DB schema / migration changes). REQUIRED on every gate.
    warningColor: string; // 'yellow' | 'red'
    // Example/inactive gate: parsed and kept in the file (JSON has no comments) but skipped at
    // compute/render time. Other projects flip this to false and tune patterns/warningColor.
    disabled: boolean;

    constructor(name: string, patterns: string[], warningColor: string, disabled = false) {
        this.name = name;
        this.patterns = patterns;
        this.warningColor = warningColor;
        this.disabled = disabled;
    }
}

// How wp-finish-upsert-pr should try to LAND the PR once it has posted it. GitHub's auto-merge queue
// is a REPO-level setting (`allow_auto_merge`) that many orgs turn OFF as a policy control, and it
// CANNOT be forced from the client: `gh pr merge --auto` calls the enablePullRequestAutoMerge GraphQL
// mutation, which hard-errors with "Auto merge is not allowed for this repository" when the repo says
// no. So the only lever a config knob has is WHICH PATHS WE ATTEMPT — never whether the queue exists.
export const MERGE_MODE_AUTO = 'AUTO';
export const MERGE_MODE_NONE = 'NONE';
export const MERGE_MODES = [MERGE_MODE_AUTO, MERGE_MODE_NONE];

/**
 * `pr-gate.landPr` — what happens to the LOCAL branch once its PR has landed.
 *
 * A rich object rather than a bare string (the `commands.pr-gate` precedent) so the next knob about
 * landing has a home, and so the rationale can sit beside the setting as a `*Why` sibling: JSON has no
 * comments, and `<key>Why` is how this repo documents non-obvious config.
 */
/**
 * One `pr-gate.reviewContext` entry: a human label and a repo-relative path a reviewer is handed instead of
 * having to find it. Data-only (per CLAUDE.md).
 */
export class ReviewContextEntry {
    label: string;
    path: string; // repo-relative in config; resolved to absolute when written into an instructions file

    constructor(label: string, entryPath: string) {
        this.label = label;
        this.path = entryPath;
    }
}

export class LandPrConfig {
    // One of BRANCH_RETENTIONS. Defaults to 'archive-tag' — see BranchArchiver for why a tag beats
    // keeping the branch, storing a patch, or trusting the reflog.
    branchRetention: string;

    constructor(branchRetention: string = BRANCH_RETENTION_ARCHIVE_TAG) {
        this.branchRetention = branchRetention;
    }
}

// webpieces-disable no-function-outside-class -- module-level config default, matches defaultGates/defaultPrGateConfig in this file
export function defaultLandPrConfig(): LandPrConfig {
    return new LandPrConfig(BRANCH_RETENTION_ARCHIVE_TAG);
}

export class PrGateConfig {
    mode: string;
    /**
     * The nx-affected build gate command, shared by the two commands that can run it.
     *
     * It is NOT finish-only any more, and the change is the point. It used to run once, in
     * wp-finish-upsert-pr, which meant reviewers were spawned against a branch nobody had built — they could
     * spend a full review on code that does not compile, or on an unresolved 3-point merge.
     *
     * Now `wp-review-upsert-pr` finalizes the merge and runs this gate BEFORE briefing any reviewer, and
     * records the passing HEAD sha in the stage receipt. `wp-finish-upsert-pr` re-runs it only when HEAD has
     * moved since — so the flow gained a gate where it mattered without paying for two full builds.
     *
     * Empty string => BuildAffected falls back to DEFAULT_BUILD_COMMAND.
     */
    buildCommand: string;
    gates: GateDefinition[];
    /**
     * REQUIRED — every repo must state its policy; there is deliberately no default, because the two
     * answers are a real policy decision and guessing it either merges when a team did not want that,
     * or silently stops landing PRs on a team that relied on it.
     *
     * AUTO — wp-finish-upsert-pr LANDS the PR: squash-merge it right away when it is mergeable, else
     *   enable GitHub auto-merge so it lands when the checks pass. Both carry an explicit --subject /
     *   --body-file, which is the ONLY way main's history gets the PR title plus the compact
     *   risk/flags body — no repo setting can produce that. Requires allow_auto_merge on the repo.
     * NONE — wp-finish-upsert-pr only opens/updates the PR and stops; a human merges. NOTE the cost:
     *   a UI merge cannot use the compact body, so main's commit falls back to the repo's
     *   squash_merge_commit_title/message settings. Set squash_merge_commit_title=PR_TITLE there, or
     *   commits land as the internal "Squash merge of <branch>" subject.
     */
    mergeMode: string;
    // This repo's review checklists, straight from the `pr-gate.checklists` ARRAY in webpieces.config.json —
    // the ONLY accepted shape (`patterns` is a path-glob dispatch table and `subagent` a name binding, so both
    // are config). [] = no checklists. The removed `{ doc }` manifest form is a hard config error; see
    // validateChecklistsSection.
    checklists: ChecklistDefinition[];
    // Whether wp-finish-upsert-pr publishes each reviewer's full `output` as ONE combined PR comment
    // (idempotently updated on every push). Defaults to true. Set false to keep the PR body-only.
    checklistComments: boolean;
    /**
     * Shared secret used to mint the server-verifiable gate token. `wp-finish-upsert-pr` writes
     * `HMAC(gateSalt, HEAD_sha)` as a hidden marker into the PR body (and REFUSES to mint it unless
     * every BLOCK checklist passed), so a valid token IS proof the local gate ran and passed. A CI
     * check (`wp-check-pr` + the scaffolded workflow) recomputes it from the PR head sha and this salt.
     *
     * Optional, defaults to '' — empty means "no token minted, no CI enforcement" (byte-identical to
     * before this field existed). This is COMMITTED, obscurity-grade: it stops unhooked teammates who
     * push + open a PR in the web UI, but is readable in-repo and therefore forgeable by a determined
     * reader. It is deliberately NOT cryptographically sound; nothing local can stop a filesystem-reading
     * agent. See RESPONSE-pr-gate-ci-enforcement / the design memo for the full tradeoff.
     */
    gateSalt: string;
    /**
     * What `wp-land-pr` (and `wp-cleanup`, which reaps the same branches) does with the LOCAL branch
     * once its PR is in main. Field-with-default rather than another positional constructor param —
     * this constructor is already at the max-params limit, and every existing `new PrGateConfig(...)`
     * call site correctly wants the default.
     */
    landPr: LandPrConfig = defaultLandPrConfig();
    /**
     * Globs whose diffs are NOT extracted into `.webpieces/pr-review/<feature>/diff/` — regenerated noise a
     * reviewer should not spend context reading (lockfiles, generated graphs). Default [].
     *
     * They are still MATCHED against checklists and still listed in the manifest, with a stub naming the
     * command that gets the real diff. Removing them from the changed-file set would read as "this file did
     * not change", which is a different and false claim.
     *
     * Fields-with-defaults rather than constructor params: that constructor is already at max-params, and
     * every existing `new PrGateConfig(...)` correctly wants the defaults.
     */
    reviewDiffExclude: string[] = [];
    /**
     * Repo-specific places a reviewer would otherwise hunt for, as `{label, path}` — e.g.
     * `{"label":"Cloud Tasks queue names","path":"terraform/services/"}`. Resolved to absolute paths in each
     * generated instructions file; a configured-but-missing path is printed as missing, never dropped.
     */
    reviewContext: ReviewContextEntry[] = [];
    /**
     * Installed packages to resolve and hand reviewers by absolute directory. This is the knob aimed at a
     * measured failure: one reviewer burned three separate greps into `node_modules/@webpieces` looking for
     * a scanner the tooling could have pointed at directly.
     */
    reviewContextPackages: string[] = [];
    /**
     * Promote "this reviewer wrote a verdict without ever opening the diff" from a warning to a refusal.
     * Default false, and it should stay false until a repo has watched the warning for a while: the signal
     * is derived from undocumented Claude Code transcript internals, so a format change would otherwise
     * wedge every PR in the repo with no self-service way out.
     */
    requireDiffEvidence = false;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(mode: string, buildCommand: string, gates: GateDefinition[], mergeMode: string, checklists: ChecklistDefinition[] = [], gateSalt = '', checklistComments = true) {
        this.mode = mode;
        this.buildCommand = buildCommand;
        this.gates = gates;
        this.mergeMode = mergeMode;
        this.checklists = checklists;
        this.gateSalt = gateSalt;
        this.checklistComments = checklistComments;
    }
}

// Default infra gates — path-pattern based, tuned for this monorepo. Clients override the
// whole list via the `pr-gate.gates` array in webpieces.config.json.
export function defaultGates(): GateDefinition[] {
    return [
        new GateDefinition('API Changed', ['libraries/apis/**', '**/*Api.ts'], 'yellow'),
        new GateDefinition('Config Files Changed', ['**/package.json', '**/tsconfig*.json', 'nx.json', '**/*.config.*'], 'yellow'),
        new GateDefinition('Dependency Graph Changed', ['architecture/dependencies.json'], 'yellow'),
        new GateDefinition('Claude / Rules Changed', ['**/CLAUDE.md', '**/claude.*.md', '.claude/**', 'webpieces.config.json'], 'yellow'),
    ];
}

export function defaultPrGateConfig(): PrGateConfig {
    // No default checklists — the extension point is opt-in; the default monorepo ships none.
    return new PrGateConfig('ON', '', defaultGates(), MERGE_MODE_AUTO, []);
}

interface RawGate {
    name?: string;
    patterns?: string[];
    warningColor?: string;
    disabled?: boolean;
}

interface RawPrGateSection {
    mode?: string;
    buildCommand?: string;
    gates?: RawGate[];
    mergeMode?: string;
    // An ARRAY, always. validateChecklistsSection rejects every other shape (including the removed { doc }).
    checklists?: RawChecklistItem[];
    gateSalt?: string;
    checklistComments?: boolean;
    landPr?: RawLandPr;
    reviewDiffExclude?: string[];
    reviewContext?: RawReviewContext[];
    reviewContextPackages?: string[];
    requireDiffEvidence?: boolean;
}

interface RawLandPr {
    branchRetention?: string;
}

interface RawReviewContext {
    label?: string;
    path?: string;
}

function toGate(raw: RawGate): GateDefinition {
    return new GateDefinition(raw.name ?? '', raw.patterns ?? [], raw.warningColor ?? 'yellow', raw.disabled ?? false);
}

/**
 * Build a PrGateConfig from the already-parsed top-level `pr-gate` section, falling back to defaults
 * for any field the consumer omits. Pure transform — the file read + structural validation happen in
 * loadAndValidate (load-config.ts) so every consumer goes through one validated path. Pass undefined
 * (no `pr-gate` key / no config file) to get full defaults.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed here
export function buildPrGateConfig(section: unknown): PrGateConfig {
    const defaults = defaultPrGateConfig();
    if (section === undefined || section === null || typeof section !== 'object') return defaults;

    const raw = section as RawPrGateSection;
    const mode = raw.mode ?? defaults.mode;
    const buildCommand = raw.buildCommand ?? defaults.buildCommand;
    const gates = raw.gates !== undefined ? raw.gates.map(toGate) : defaults.gates;
    // REQUIRED — validatePrGateSection rejects an omitted/unknown value, so this fallback only ever
    // applies to the no-config-file path that defaultPrGateConfig() serves.
    const mergeMode = raw.mergeMode ?? defaults.mergeMode;
    // Optional extension point — omitted ⇒ [] ⇒ no checklists computed anywhere downstream. A non-array here
    // cannot reach us: validateChecklistsSection has already failed the load.
    const checklists = Array.isArray(raw.checklists)
        ? raw.checklists.map((item: RawChecklistItem): ChecklistDefinition => toChecklist(item))
        : defaults.checklists;
    // Optional — omitted ⇒ '' ⇒ no gate token minted and CI enforcement is a no-op (back-compat).
    const gateSalt = raw.gateSalt ?? defaults.gateSalt;
    // Optional — omitted ⇒ true ⇒ reviewer output published as a PR comment.
    const checklistComments = raw.checklistComments ?? defaults.checklistComments;
    const built = new PrGateConfig(mode, buildCommand, gates, mergeMode, checklists, gateSalt, checklistComments);
    built.landPr = buildLandPrConfig(raw.landPr);
    // Review-context knobs. All optional and all defaulted, so a config that omits every one of them (which
    // is every consumer's config today) behaves exactly as it did before they existed.
    built.reviewDiffExclude = Array.isArray(raw.reviewDiffExclude) ? raw.reviewDiffExclude : defaults.reviewDiffExclude;
    built.reviewContextPackages = Array.isArray(raw.reviewContextPackages) ? raw.reviewContextPackages : defaults.reviewContextPackages;
    built.reviewContext = Array.isArray(raw.reviewContext)
        ? raw.reviewContext.map((e: RawReviewContext): ReviewContextEntry => new ReviewContextEntry(e.label ?? '', e.path ?? ''))
        : defaults.reviewContext;
    built.requireDiffEvidence = raw.requireDiffEvidence ?? defaults.requireDiffEvidence;
    return built;
}

/**
 * Build the `pr-gate.landPr` block. Omitted (the current state of every consumer's config) ⇒ the
 * 'archive-tag' default, which is what makes this feature work with NO config edit at all. An invalid
 * value cannot reach here — validatePrGateSection has already failed the load.
 */
// webpieces-disable no-function-outside-class -- module-level config transform, matches buildPrGateConfig above
export function buildLandPrConfig(raw: RawLandPr | undefined): LandPrConfig {
    const defaults = defaultLandPrConfig();
    if (raw === undefined || raw === null || typeof raw !== 'object') return defaults;
    const retention = raw.branchRetention;
    if (typeof retention !== 'string' || !BRANCH_RETENTIONS.includes(retention)) return defaults;
    return new LandPrConfig(retention);
}

