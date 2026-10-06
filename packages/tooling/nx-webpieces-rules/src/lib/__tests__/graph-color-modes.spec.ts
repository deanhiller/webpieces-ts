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

describe('Runtime stripes', () => {
    it('stripes a universal library equally, in the fixed order browser | node | react-native', () => {
        const dot = styler.dots(new NodeFacts('u', 'u', 0, 'lib', ['react-native', 'node', 'browser'])).runtime;
        const order = ['#b9a7e6', '#ffe07a', '#7fd1c4'].map((color: string): number =>
            dot.indexOf(`BGCOLOR="${color}" WIDTH=`),
        );
        expect(order.every((index: number): boolean => index > 0)).toBe(true);
        expect([...order].sort((a: number, b: number): number => a - b)).toEqual(order);
        const widths = [...dot.matchAll(/<TD BGCOLOR="#[0-9a-f]{6}" WIDTH="(\d+)"/g)].map(
            (match: RegExpMatchArray): string => match[1],
        );
        expect(new Set(widths).size).toBe(1);
    });

    it('draws a react-native-only box teal, as a plain fill', () => {
        const dot = styler.dots(new NodeFacts('rn', 'rn', 0, 'client', ['react-native'])).runtime;
        expect(dot).toBe('  "rn" [style="filled", fillcolor="#7fd1c4", label="rn\\nL0 · client"];\n');
    });

    it('keeps a two-runtime box WITH a specialization legible: text on a plate, the inset in its stripe', () => {
        const dot = styler.dots(
            new NodeFacts('shared-hooks', 'shared-hooks', 4, 'lib', ['react', 'react-native']),
        ).runtime;
        // The plate spans both stripes and carries the name and meta.
        expect(dot).toContain(
            '<TD COLSPAN="2" BGCOLOR="#fbfbfd" CELLPADDING="4">shared-hooks<BR/>L4 · lib</TD>',
        );
        // react's blue inset sits inside the browser (purple) stripe; react-native is its own teal stripe.
        expect(dot).toContain(
            '<TD BGCOLOR="#b9a7e6" CELLPADDING="4"><TABLE BORDER="0" CELLSPACING="0" CELLPADDING="0" BGCOLOR="#8fd3f7"',
        );
        expect(dot).toContain('<TD BGCOLOR="#7fd1c4" WIDTH=');
        // The stripe bands sit above AND below the plate.
        const plate = dot.indexOf('COLSPAN="2"');
        expect(dot.indexOf('BGCOLOR="#7fd1c4"')).toBeLessThan(plate);
        expect(dot.lastIndexOf('BGCOLOR="#7fd1c4"')).toBeGreaterThan(plate);
        // The name is never inside a colored stripe cell.
        expect(dot).not.toMatch(/BGCOLOR="#(b9a7e6|7fd1c4|8fd3f7)"[^<]*>shared-hooks/);
    });

    it('entity-escapes names inside HTML-like labels', () => {
        expect(htmlLabelText('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
        const dot = styler.dots(new NodeFacts('x', 'a<b>', 0, 'lib', ['angular'])).runtime;
        expect(dot).toContain('a&lt;b&gt;<BR/>');
        expect(dot).not.toContain('a<b>');
    });
});
