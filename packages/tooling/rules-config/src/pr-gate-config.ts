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

export class PrGateConfig {
    mode: string;
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

    constructor(mode: string, buildCommand: string, gates: GateDefinition[], mergeMode: string) {
        this.mode = mode;
        this.buildCommand = buildCommand;
        this.gates = gates;
        this.mergeMode = mergeMode;
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
    return new PrGateConfig('ON', '', defaultGates(), MERGE_MODE_AUTO);
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
    return new PrGateConfig(mode, buildCommand, gates, mergeMode);
}
