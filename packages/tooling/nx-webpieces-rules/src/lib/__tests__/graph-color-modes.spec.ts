/**
 * The drift guard #1155 asked for: react-native shipped with a validator entry but no graph color and
 * no legend row, and the `app`/`bundle` borders were drawn but never explained. These assertions tie
 * the renderer's colors and legend to the SHARED vocabularies, so the next framework or role added to
 * them fails here instead of silently rendering grey.
 */

import { describe, it, expect } from 'vitest';
import { KNOWN_FRAMEWORKS } from '@webpieces/rules-sdk';
import {
    FRAMEWORK_STYLES,
    FrameworkStyle,
    LegendFacts,
    NodeFacts,
    NodeModeStyler,
    ROLE_STYLES,
    RoleStyle,
} from '../graph-color-modes';
import { GraphLegend } from '../graph-legend';
import { KNOWN_ROLES } from '../role-resolver';
import { htmlLabelText } from '../dot-syntax';
import { GraphPageStyles } from '../graph-page-styles';
import { LevelBand, LevelBandLayout } from '../graph-level-bands';

const styler = new NodeModeStyler();
const legend = new GraphLegend();

/** Legend facts as if every framework and every role were drawn. */
const everything = (): LegendFacts => {
    const facts = new LegendFacts();
    for (const framework of KNOWN_FRAMEWORKS)
        styler.record(facts, new NodeFacts(framework, framework, 0, 'lib', [framework]));
    for (const role of KNOWN_ROLES) styler.record(facts, new NodeFacts(role, role, 0, role, []));
    return facts;
};

describe('every known framework has a color and a legend row', () => {
    it.each([...KNOWN_FRAMEWORKS])('%s', (framework: string) => {
        const style = styler.styleOf(framework);
        expect(style).toBeDefined();
        expect(style!.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(legend.runtimeRows(everything())).toContain(`data-wp-legend="${framework}"`);
    });

    it('covers the six the framework-tag validator knows, react-native included', () => {
        expect([...KNOWN_FRAMEWORKS].sort()).toEqual(
            ['angular', 'browser', 'express', 'node', 'react', 'react-native'],
        );
        expect(Object.keys(FRAMEWORK_STYLES).sort()).toEqual([...KNOWN_FRAMEWORKS].sort());
    });

    it('gives every runtime a distinct color', () => {
        const colors = Object.values(FRAMEWORK_STYLES).map((style: FrameworkStyle): string => style.color);
        expect(new Set(colors).size).toBe(colors.length);
    });
});

describe('every role the renderer styles has a color and a legend row', () => {
    it('styles exactly the roles role-resolver knows', () => {
        expect([...styler.styledRoles()].sort()).toEqual([...KNOWN_ROLES].sort());
    });

    it.each(ROLE_STYLES.map((style: RoleStyle): string => style.role))('%s', (role: string) => {
        expect(legend.architectureRows(everything())).toContain(`data-wp-legend="${role}"`);
    });

    it('lists only the roles in use', () => {
        const facts = new LegendFacts();
        styler.record(facts, new NodeFacts('svc', 'svc', 1, 'server', ['node']));
        const rows = legend.architectureRows(facts);
        expect(rows).toContain('data-wp-legend="server"');
        expect(rows).not.toContain('data-wp-legend="app"');
    });
});

describe('the brand palette (#1158)', () => {
    it('uses the LangLearn-matched runtime colors, with text colors that read on them', () => {
        const colors = Object.fromEntries(
            Object.values(FRAMEWORK_STYLES).map((style: FrameworkStyle): [string, string] => [
                style.framework,
                `${style.color}/${style.fontColor}`,
            ]),
        );
        expect(colors).toEqual({
            browser: '#7d8cf2/#1a1c22',
            node: '#6fcf8a/#1a1c22',
            'react-native': '#34b8a6/#1a1c22',
            angular: '#c8243f/#ffffff',
            react: '#7fd8ff/#1a1c22',
            express: '#2e7d4f/#ffffff',
        });
    });

    it('moves bundle to indigo, so no box color equals the violet accent', () => {
        const fills = ROLE_STYLES.map((style: RoleStyle): string => style.fill);
        expect(ROLE_STYLES.find((style: RoleStyle): boolean => style.role === 'bundle')!.fill).toBe('#4b44c8');
        for (const color of [...fills, ...Object.values(FRAMEWORK_STYLES).map((s: FrameworkStyle): string => s.color)])
            expect(['#8b3cf0', '#a46bf7']).not.toContain(color);
    });

    it('styles the drawer charcoal with the violet accent, and keeps the canvas light', () => {
        const css = new GraphPageStyles().css();
        for (const token of ['--wp-side-bg: #15161b', '--wp-side-control: #1e1f25', '--wp-side-line: #3a3c46',
            '--wp-accent: #8b3cf0', '--wp-accent-hover: #a46bf7', '--wp-canvas: #faf9f5'])
            expect(css).toContain(token);
    });
});

describe('Runtime boxes: solid, nested or striped — never bands or a plate', () => {
    it('stripes a universal library full height, equally, in the fixed order browser | node | react-native', () => {
        const dot = styler.dots(new NodeFacts('u', 'u', 0, 'lib', ['react-native', 'node', 'browser'])).runtime;
        expect(dot).toContain('style="striped", fillcolor="#7d8cf2;0.333:#6fcf8a;0.333:#34b8a6", class="wp-striped"');
        expect(dot).not.toContain('<TABLE');
        expect(dot).toContain('<BR/>browser · node · react-native>');
    });

    it('draws a react-native-only box teal, as a plain fill with the three lines', () => {
        const dot = styler.dots(new NodeFacts('rn', 'rn', 0, 'client', ['react-native'])).runtime;
        expect(dot).toBe(
            '  "rn" [style="filled", fillcolor="#34b8a6", fontcolor="#1a1c22", label=<<FONT COLOR="#1a1c2299">L0</FONT>' +
                '&#160;&#160;<B>rn</B><BR/>client<BR/>react-native>];\n',
        );
    });

    it('NESTS one runtime plus a specialization: base frame, rounded inner box, text color of the inner', () => {
        const dot = styler.dots(new NodeFacts('site', 'site', 3, 'client', ['browser', 'angular'])).runtime;
        expect(dot).toContain('fillcolor="#7d8cf2", fontcolor="#ffffff", margin=0');
        expect(dot).toContain(
            '<TD BGCOLOR="#7d8cf2" CELLPADDING="5"><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" BGCOLOR="#c8243f" STYLE="rounded"><TR><TD><FONT COLOR="#ffffff99">L3</FONT>',
        );
        // react is light, so its text stays dark.
        const react = styler.dots(new NodeFacts('r', 'r', 1, 'lib', ['react'])).runtime;
        expect(react).toContain('fontcolor="#1a1c22", margin=0');
        expect(react).toContain('BGCOLOR="#7fd8ff" STYLE="rounded"');
    });

    it('shows a specialization on a multi-runtime box in line 3 only', () => {
        const dot = styler.dots(new NodeFacts('hooks', 'hooks', 4, 'lib', ['react', 'react-native'])).runtime;
        expect(dot).toContain('style="striped", fillcolor="#7d8cf2;0.500:#34b8a6"');
        expect(dot).not.toContain('#7fd8ff');
        expect(dot).toContain('<BR/>react-native · react>');
    });

    it('entity-escapes names inside HTML-like labels', () => {
        expect(htmlLabelText('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
        const dot = styler.dots(new NodeFacts('x', 'a<b>', 0, 'lib', ['angular'])).runtime;
        expect(dot).toContain('<B>a&lt;b&gt;</B>');
        expect(dot).not.toContain('a<b>');
    });
});

describe('hover glow and lock outline stay on the OUTER box (#1158)', () => {
    const css = new GraphPageStyles().css();
    const later = ':is(polygon, ellipse, path) ~ :is(polygon, ellipse, path)';

    it('suppresses the glow on every shape after the first, whatever its element type', () => {
        // A nested box renders its inner STYLE="rounded" table as a <path>, after the node's polygon:
        // the old `polygon:not(:first-of-type)` rule missed it and the glow stroked the inner box.
        expect(css).toContain(`#graph g.wp-node-clickable:hover > ${later} { stroke: none; stroke-width: 0; filter: none; }`);
        expect(css).not.toContain('polygon:not(:first-of-type)');
    });

    it('locks the first shape only — and a striped box by its last, unfilled outline', () => {
        expect(css).toContain(`#graph g.node.wp-locked:not(.wp-striped) > :is(polygon, ellipse, path):not(${later}),`);
        expect(css).toContain('#graph g.node.wp-locked.wp-striped > polygon[fill="none"] { stroke: var(--wp-accent); stroke-width: 3; }');
        expect(css).not.toContain('g.node.wp-locked > path');
        expect(css).toContain('#graph g.wp-node-clickable.wp-striped:hover > polygon[fill="none"] { stroke: var(--wp-accent)');
    });
});

describe('an emptied level is a thin labeled band, never dropped', () => {
    it('keeps the empty band in the rank chain with a visible label', () => {
        const dot = new LevelBandLayout().dot([new LevelBand(2, ['a']), new LevelBand(1, []), new LevelBand(0, ['b'])]);
        expect(dot).toContain('"__wp_layout_L1" [shape=plaintext');
        expect(dot).toContain('label="L1 · no matching projects", class="wp-layout wp-empty-level"]');
        expect(dot).toContain('"__wp_layout_L2" -> "__wp_layout_L1"');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_L0"');
    });
});

