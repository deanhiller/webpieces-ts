import * as fs from 'fs';
import { findConfigFile } from './load-config';

// PrGateConfig is the "special section" for the pr-gate dashboard. It does NOT live in the
// validated `rules` map (the FieldDef schema can't express nested object arrays), but as a
// top-level `pr-gate` key in webpieces.config.json. Loaded by loadPrGateConfig with defaults.

export class GateDefinition {
    name: string;
    patterns: string[];
    severity: string; // 'warn' (yellow) | 'block' (red, fails the gate)

    constructor(name: string, patterns: string[], severity: string) {
        this.name = name;
        this.patterns = patterns;
        this.severity = severity;
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
        new GateDefinition('API Changed', ['libraries/apis/**', '**/*Api.ts'], 'warn'),
        new GateDefinition('Config Files Changed', ['**/package.json', '**/tsconfig*.json', 'nx.json', '**/*.config.*'], 'warn'),
        new GateDefinition('Dependency Graph Changed', ['architecture/dependencies.json'], 'warn'),
        new GateDefinition('Claude / Rules Changed', ['**/CLAUDE.md', '**/claude.*.md', '.claude/**', 'webpieces.config.json'], 'warn'),
    ];
}

export function defaultPrGateConfig(): PrGateConfig {
    return new PrGateConfig('ON', '', defaultGates());
}

interface RawGate {
    name?: string;
    patterns?: string[];
    severity?: string;
}

interface RawPrGateSection {
    mode?: string;
    buildCommand?: string;
    gates?: RawGate[];
}

// webpieces-disable no-any-unknown -- consumer JSON config has opaque shape until narrowed
interface RawConfigWithPrGate {
    'pr-gate'?: RawPrGateSection;
}

function toGate(raw: RawGate): GateDefinition {
    return new GateDefinition(raw.name ?? '', raw.patterns ?? [], raw.severity ?? 'warn');
}

/**
 * Load the `pr-gate` section from webpieces.config.json, falling back to defaults for any
 * field the consumer omits. Returns defaults entirely if no config file is found.
 */
export function loadPrGateConfig(cwd: string): PrGateConfig {
    const defaults = defaultPrGateConfig();
    const configPath = findConfigFile(cwd);
    if (!configPath) return defaults;

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RawConfigWithPrGate;
    const section = parsed['pr-gate'];
    if (!section) return defaults;

    const mode = section.mode ?? defaults.mode;
    const buildCommand = section.buildCommand ?? defaults.buildCommand;
    const gates = section.gates !== undefined ? section.gates.map(toGate) : defaults.gates;
    return new PrGateConfig(mode, buildCommand, gates);
}
