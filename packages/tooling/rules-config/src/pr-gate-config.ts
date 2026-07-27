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
export const MERGE_MODE_DETECT = 'DETECT';
export const MERGE_MODE_DIRECT = 'DIRECT';
export const MERGE_MODE_NONE = 'NONE';
export const MERGE_MODES = [MERGE_MODE_DETECT, MERGE_MODE_DIRECT, MERGE_MODE_NONE];

export class PrGateConfig {
    mode: string;
    buildCommand: string;
    gates: GateDefinition[];
    /**
     * DETECT (default) — merge directly when the PR is mergeable; when it is NOT, ask the repo whether
     *   auto-merge is allowed and queue it only if the answer is yes. Correct on both kinds of repo
     *   with zero configuration, which is why it is the default: nobody has to set this.
     * DIRECT — merge directly when mergeable, but NEVER queue auto-merge even where it is allowed.
     *   For teams who want the merge to happen only while a run is watching it.
     * NONE — post/update the PR and stop; nothing is merged or queued and a human clicks merge. For
     *   repos whose policy is "no merge without a person" — which is usually what allow_auto_merge=false
     *   is really expressing. Pair it with the repo's squash_merge_commit_title=PR_TITLE +
     *   squash_merge_commit_message=PR_BODY so the human's UI merge still lands a good commit message.
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
    return new PrGateConfig('ON', '', defaultGates(), MERGE_MODE_DETECT);
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
    // Omitted (the normal case) means DETECT — the mode that is right on both kinds of repo.
    const mergeMode = raw.mergeMode ?? defaults.mergeMode;
    return new PrGateConfig(mode, buildCommand, gates, mergeMode);
}
