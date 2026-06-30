// PrGateConfig is the "special section" for the pr-gate dashboard. It does NOT live in the
// validated `rules` map (the FieldDef schema can't express nested object arrays), but as a
// top-level `pr-gate` key in webpieces.config.json. It is built and validated by
// loadAndValidate (load-config.ts); this module holds only the data classes + defaults + toGate.

export class GateDefinition {
    name: string;
    patterns: string[];
    // The color shown on the dashboard WHEN this gate's patterns match a changed file. Green is
    // implicit (shown when nothing matched), so it is never configured. Color is purely visual —
    // even 'red' never fails/blocks the PR (only the build gate can). 'yellow' = caution,
    // 'red' = louder "look here" flag (e.g. DB schema / migration changes).
    color: string; // 'yellow' | 'red'
    // Example/inactive gate: parsed and kept in the file (JSON has no comments) but skipped at
    // compute/render time. Other projects flip this to false and tune patterns/color.
    disabled: boolean;

    constructor(name: string, patterns: string[], color: string, disabled = false) {
        this.name = name;
        this.patterns = patterns;
        this.color = color;
        this.disabled = disabled;
    }
}

export class PrGateConfig {
    mode: string;
    buildCommand: string;
    gates: GateDefinition[];

    constructor(mode: string, buildCommand: string, gates: GateDefinition[]) {
        this.mode = mode;
        this.buildCommand = buildCommand;
        this.gates = gates;
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
    return new PrGateConfig('ON', '', defaultGates());
}

interface RawGate {
    name?: string;
    patterns?: string[];
    color?: string;
    disabled?: boolean;
}

interface RawPrGateSection {
    mode?: string;
    buildCommand?: string;
    gates?: RawGate[];
}

function toGate(raw: RawGate): GateDefinition {
    return new GateDefinition(raw.name ?? '', raw.patterns ?? [], raw.color ?? 'yellow', raw.disabled ?? false);
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
    return new PrGateConfig(mode, buildCommand, gates);
}
