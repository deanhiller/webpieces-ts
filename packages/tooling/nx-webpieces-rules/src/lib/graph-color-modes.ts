/**
 * Graph color modes (#1155)
 *
 * The architecture graph answers ONE question at a time instead of asking every box to encode two
 * (fill = framework AND border = role). Each box is emitted once per mode, so the page can switch
 * modes and re-render without regenerating anything:
 *
 *  - RUNTIME      "where the code can run". Base runtimes are equal vertical stripes in the fixed
 *                 order browser | node | react-native; a specialization (angular/react inside
 *                 browser, express inside node) is an inset inside its base stripe. The dependency
 *                 rule becomes visual: a box may depend on a box carrying every color it has. The
 *                 name and meta sit on a light label PLATE across the middle, so they read on every
 *                 stripe combination while the stripes and insets stay visible above and below it.
 *  - ARCHITECTURE "servers · clients · APIs". A solid fill by ROLE; framework color is not shown.
 *  - IMPACT       "what this branch touches". Projects owning a changed file are solid amber
 *                 ("touched"); the rest of nx's affected set is light amber ("affected": their ci
 *                 re-runs); every transitive dependency of the affected set that is not itself
 *                 affected is light slate with a dashed border ("build input": compiled or restored
 *                 from cache, unchanged); everything else is grey. Which box is which is only known
 *                 per branch, so every box carries all four variants and the page picks one from the
 *                 sidecar (graph-impact.ts).
 */

import { KNOWN_FRAMEWORKS, KnownFramework } from '@webpieces/rules-sdk';
import { dotValue, htmlLabelText } from './dot-syntax';

export enum GraphMode {
    RUNTIME = 'runtime',
    ARCHITECTURE = 'architecture',
    IMPACT = 'impact',
}

/** One selectable mode as the drawer and the node menu show it. */
export class ModeInfo {
    constructor(
        public readonly mode: GraphMode,
        public readonly name: string,
        public readonly subtitle: string,
    ) {}
}

/** In key order: `1` selects the first, `2` the second, `3` the third. */
export const GRAPH_MODES: readonly ModeInfo[] = [
    new ModeInfo(GraphMode.RUNTIME, 'Runtime', 'where the code can run'),
    new ModeInfo(GraphMode.ARCHITECTURE, 'Architecture', 'servers · clients · APIs'),
    new ModeInfo(GraphMode.IMPACT, 'Impact', 'what this branch touches'),
];

/** A framework value's color and the BASE runtime it is drawn inside (itself, for a base). */
export class FrameworkStyle {
    constructor(
        public readonly framework: KnownFramework,
        public readonly base: KnownFramework,
        public readonly color: string,
        public readonly description: string,
    ) {}

    isBase(): boolean {
        return this.framework === this.base;
    }
}

/**
 * Keyed by the shared vocabulary, so a framework added to KNOWN_FRAMEWORKS without a color here is a
 * COMPILE error — not a box silently painted grey and missing from the legend, which is exactly how
 * react-native shipped (#1155).
 */
export const FRAMEWORK_STYLES: Record<KnownFramework, FrameworkStyle> = {
    browser: new FrameworkStyle('browser', 'browser', '#b9a7e6', 'browser base runtime'),
    node: new FrameworkStyle('node', 'node', '#ffe07a', 'node base runtime'),
    'react-native': new FrameworkStyle(
        'react-native',
        'react-native',
        '#7fd1c4',
        'its own runtime, not a browser',
    ),
    angular: new FrameworkStyle('angular', 'browser', '#f59ab9', 'inside browser'),
    react: new FrameworkStyle('react', 'browser', '#8fd3f7', 'inside browser'),
    express: new FrameworkStyle('express', 'node', '#9fd8a3', 'inside node'),
};

/** Stripe order, left to right. Fixed, so the same set always reads the same way. */
export const BASE_ORDER: readonly KnownFramework[] = ['browser', 'node', 'react-native'];

/** A box with no known framework tag. */
export const NO_RUNTIME_COLOR = '#e4e6ec';

/** A role's solid fill and the text color that stays readable on it. */
export class RoleStyle {
    constructor(
        public readonly role: string,
        public readonly fill: string,
        public readonly fontColor: string,
        public readonly description: string,
    ) {}
}

/** Every role role-resolver knows, in legend order (runnable things first). */
export const ROLE_STYLES: readonly RoleStyle[] = [
    new RoleStyle('server', '#4caf50', '#ffffff', 'runnable server'),
    new RoleStyle('client', '#e5533d', '#ffffff', 'browser or mobile client app'),
    new RoleStyle('app', '#1e88e5', '#ffffff', 'runnable non-HTTP app'),
    new RoleStyle('bundle', '#7b3fa6', '#ffffff', 'bundles several apps'),
    new RoleStyle('api-lib', '#f08a24', '#1a1c22', 'contract + DTOs'),
    new RoleStyle('api-client', '#1a9aa6', '#ffffff', 'contract + SDK implementation'),
    new RoleStyle('designed-lib', '#7d8597', '#ffffff', 'library with a generated design'),
    new RoleStyle('lib', '#d7dae2', '#1a1c22', 'plain library'),
];

/** The four impact shades (graph-impact.ts decides which box gets which). */
export const IMPACT_TOUCHED = '#f5a524';
export const IMPACT_AFFECTED = '#fde3b0';
export const IMPACT_BUILD_INPUT = '#e3e9f2';
export const IMPACT_BUILD_INPUT_BORDER = '#7c8aa3';
export const IMPACT_UNTOUCHED = '#eef0f4';

/** The light plate the name and meta sit on, across every stripe of a multi-color box. */
export const LABEL_PLATE = '#fbfbfd';
/** Height of each stripe band above and below the plate. */
const STRIPE_HEIGHT = 16;
/** Margin of base color around a specialization's inset (inside one stripe band). */
const INSET_PAD = 4;
/** Padding around the text on the plate. */
const PLATE_PAD = 4;
/** No stripe narrower than this, however short the name. */
const MIN_STRIPE_WIDTH = 28;
/** Rough Arial 14 advance, used only to size the stripes so they span the text evenly. */
const CHAR_WIDTH = 7.5;

/** What a box's per-mode rendering is computed from. */
export class NodeFacts {
    constructor(
        public readonly nodeId: string,
        public readonly shortName: string,
        public readonly level: number,
        public readonly role: string,
        public readonly frameworks: string[],
    ) {}
}

/** One box's DOT statement for every mode (and for each impact state). */
export class NodeModeDots {
    constructor(
        public readonly runtime: string,
        public readonly architecture: string,
        public readonly touched: string,
        public readonly affected: string,
        public readonly buildInput: string,
        public readonly untouched: string,
    ) {}
}

/** Which colors and roles the drawn projects actually use, so the legend lists exactly those. */
export class LegendFacts {
    frameworks: string[] = [];
    roles: string[] = [];
    multiRuntime = false;
    noRuntime = false;
}

export class NodeModeStyler {
    styleOf(framework: string): FrameworkStyle | undefined {
        if (!(KNOWN_FRAMEWORKS as readonly string[]).includes(framework)) return undefined;
        return FRAMEWORK_STYLES[framework as KnownFramework];
    }

    roleStyle(role: string): RoleStyle {
        const style = ROLE_STYLES.find((candidate: RoleStyle): boolean => candidate.role === role);
        return style ?? (ROLE_STYLES.find((s: RoleStyle): boolean => s.role === 'lib') as RoleStyle);
    }

    /** Every role the renderer styles; a spec asserts this covers role-resolver's KNOWN_ROLES. */
    styledRoles(): string[] {
        return ROLE_STYLES.map((style: RoleStyle): string => style.role);
    }

    /** The base runtimes of a framework set, in stripe order (a specialization implies its base). */
    bases(frameworks: string[]): KnownFramework[] {
        const present = new Set<KnownFramework>();
        for (const framework of frameworks) {
            const style = this.styleOf(framework);
            if (style !== undefined) present.add(style.base);
        }
        return BASE_ORDER.filter((base: KnownFramework): boolean => present.has(base));
    }

    /** The specialization drawn inside `base`, if the set carries one. */
    specialization(base: KnownFramework, frameworks: string[]): FrameworkStyle | undefined {
        for (const framework of KNOWN_FRAMEWORKS) {
            const style = FRAMEWORK_STYLES[framework];
            if (style.isBase() || style.base !== base) continue;
            if (frameworks.includes(framework)) return style;
        }
        return undefined;
    }

    dots(facts: NodeFacts): NodeModeDots {
        return new NodeModeDots(
            this.runtime(facts),
            this.statement(facts, this.architectureAttrs(facts), this.plainLabel(facts, this.envMeta(facts))),
            this.statement(facts, `style="filled", fillcolor="${IMPACT_TOUCHED}"`, this.plainLabel(facts, 'touched')),
            this.statement(
                facts,
                `style="filled", fillcolor="${IMPACT_AFFECTED}", color="${IMPACT_TOUCHED}", penwidth=2`,
                this.plainLabel(facts, 'affected'),
            ),
            this.statement(
                facts,
                `style="filled,dashed", fillcolor="${IMPACT_BUILD_INPUT}", color="${IMPACT_BUILD_INPUT_BORDER}", penwidth=1.5`,
                this.plainLabel(facts, 'build input'),
            ),
            this.statement(
                facts,
                `style="filled", fillcolor="${IMPACT_UNTOUCHED}", color="#b4b9c4", fontcolor="#6b7180"`,
                this.plainLabel(facts, `L${facts.level}`),
            ),
        );
    }

    /** Fold one drawn box into the legend facts. */
    record(legend: LegendFacts, facts: NodeFacts): void {
        for (const framework of facts.frameworks) {
            if (this.styleOf(framework) !== undefined && !legend.frameworks.includes(framework))
                legend.frameworks.push(framework);
        }
        const role = this.roleStyle(facts.role).role;
        if (!legend.roles.includes(role)) legend.roles.push(role);
        const bases = this.bases(facts.frameworks);
        if (bases.length > 1) legend.multiRuntime = true;
        if (bases.length === 0) legend.noRuntime = true;
    }

    private statement(facts: NodeFacts, attrs: string, label: string): string {
        return `  "${dotValue(facts.nodeId)}" [${attrs}, ${label}];\n`;
    }

    private plainLabel(facts: NodeFacts, meta: string): string {
        return `label="${dotValue(facts.shortName)}\\n${dotValue(meta)}"`;
    }

    private runtimeMeta(facts: NodeFacts): string {
        return `L${facts.level} · ${facts.role}`;
    }

    private envMeta(facts: NodeFacts): string {
        const envs = facts.frameworks.length === 0 ? 'no framework tag' : facts.frameworks.join('+');
        return `L${facts.level} · ${envs}`;
    }

    private architectureAttrs(facts: NodeFacts): string {
        const style = this.roleStyle(facts.role);
        return `style="filled", fillcolor="${style.fill}", fontcolor="${style.fontColor}"`;
    }

    /**
     * Runtime mode. A box in ONE base runtime with no specialization is a plain fill — its dark text
     * reads on any of the pastel base colors. Every other box (several runtimes, or a specialization)
     * is an HTML-like table of three rows: a band of equal stripes, a light PLATE carrying the name and
     * meta across all of them, and the same stripes again. The stripes and insets stay visible above
     * and below the text, and the text never straddles two colors.
     */
    private runtime(facts: NodeFacts): string {
        const bases = this.bases(facts.frameworks);
        const meta = this.runtimeMeta(facts);
        if (bases.length === 0)
            return this.statement(facts, `style="filled", fillcolor="${NO_RUNTIME_COLOR}"`, this.plainLabel(facts, meta));
        const insets = bases.map((base: KnownFramework) => this.specialization(base, facts.frameworks));
        const plain = insets.every((inset: FrameworkStyle | undefined): boolean => inset === undefined);
        if (bases.length === 1 && plain)
            return this.statement(facts, this.stripeAttrs(bases), this.plainLabel(facts, meta));
        return this.statement(
            facts,
            `style="filled", fillcolor="${LABEL_PLATE}", margin=0`,
            `label=<${this.plateTable(facts, bases, insets, meta)}>`,
        );
    }

    /** `filled` for one runtime; equal `striped` weights for several (the last takes the remainder). */
    stripeAttrs(bases: KnownFramework[]): string {
        const colors = bases.map((base: KnownFramework): string => FRAMEWORK_STYLES[base].color);
        if (colors.length === 1) return `style="filled", fillcolor="${colors[0]}"`;
        const share = (1 / colors.length).toFixed(3);
        const weighted = colors.map((color: string, index: number): string =>
            index === colors.length - 1 ? color : `${color};${share}`,
        );
        return `style="striped", fillcolor="${weighted.join(':')}"`;
    }

    /**
     * Stripe band / plate / stripe band. Every stripe cell asks for the same minimum width (an
     * estimate of the text's width split evenly), so the stripes come out equal and the plate spans
     * exactly their total.
     */
    private plateTable(
        facts: NodeFacts,
        bases: KnownFramework[],
        insets: (FrameworkStyle | undefined)[],
        meta: string,
    ): string {
        const chars = Math.max(facts.shortName.length, meta.length);
        const textWidth = Math.ceil(chars * CHAR_WIDTH) + 2 * PLATE_PAD;
        const stripeWidth = Math.max(MIN_STRIPE_WIDTH, Math.ceil(textWidth / bases.length));
        const band = bases
            .map((base: KnownFramework, index: number): string =>
                this.stripeCell(FRAMEWORK_STYLES[base].color, insets[index], stripeWidth),
            )
            .join('');
        const text = `${htmlLabelText(facts.shortName)}<BR/>${htmlLabelText(meta)}`;
        return (
            '<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0">' +
            `<TR>${band}</TR>` +
            `<TR><TD COLSPAN="${bases.length}" BGCOLOR="${LABEL_PLATE}" CELLPADDING="${PLATE_PAD}">${text}</TD></TR>` +
            `<TR>${band}</TR>` +
            '</TABLE>'
        );
    }

    /** One stripe of a band: the base color, with its specialization inset inside a margin of it. */
    private stripeCell(base: string, inset: FrameworkStyle | undefined, width: number): string {
        if (inset === undefined) return `<TD BGCOLOR="${base}" WIDTH="${width}" HEIGHT="${STRIPE_HEIGHT}"></TD>`;
        const innerWidth = width - 2 * INSET_PAD;
        const innerHeight = STRIPE_HEIGHT - 2 * INSET_PAD;
        return (
            `<TD BGCOLOR="${base}" CELLPADDING="${INSET_PAD}">` +
            `<TABLE BORDER="0" CELLSPACING="0" CELLPADDING="0" BGCOLOR="${inset.color}" STYLE="rounded">` +
            `<TR><TD WIDTH="${innerWidth}" HEIGHT="${innerHeight}"></TD></TR></TABLE></TD>`
        );
    }
}
