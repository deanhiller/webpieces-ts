/**
 * The runtime architecture page's per-node menu.
 *
 * Every node on tmp/webpieces/runtime-architecture.html is clickable and opens the SAME floating
 * menu the architecture page and every design.html use — one implementation, graph-node-menu.ts.
 * These assertions are what stops a fourth page (or a refactor of this one) from growing a second
 * copy of it: they pin the SHARED class names, not a re-spelling of them.
 *
 * The client is transpiled from source rather than read from dist, exactly as graph-visualizer.spec.ts
 * does: the compiled sibling only exists after a build, and the source is what actually ships.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { RuntimeHtmlPage } from '../runtime-visualizer';

const CLIENT_TS = path.join(__dirname, '..', 'runtime-visualizer.client.ts');
const clientJs = (): string => ts.transpileModule(
    fs.readFileSync(CLIENT_TS, 'utf-8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const DOT = 'digraph G {\n  "svc-a" -> "svc-b";\n}';
const html = (): string => new RuntimeHtmlPage(clientJs).render(DOT, 'Runtime');

describe('runtime architecture page node menu', () => {
    it('inlines the shared menu implementation rather than a second copy of it', () => {
        const page = html();
        expect(page).toContain('class WpNodeMenu');
        expect(page).toContain('class WpNodeMenuItem');
        expect(page).toContain('wp-node-menu');
        // The menu's stylesheet, carrying the clickable affordance for every box.
        expect(page).toContain('g.wp-node-clickable');
    });

    it('wires EVERY node of the rendered svg to open it', () => {
        const page = html();
        expect(page).toContain("querySelectorAll('g.node')");
        expect(page).toContain('WpNodeMenu.wire');
        expect(page).toContain('RuntimeNodeMenu');
    });

    it('dismisses on an outside click and on Escape, from the shared handlers', () => {
        const page = html();
        expect(page).toContain("document.addEventListener('click'");
        expect(page).toContain("ev.key === 'Escape'");
        expect(page).toContain('WpNodeMenu.close()');
    });

    it('labels the one item Lock or Unlock from that node lock state, and toggles the same lock', () => {
        const page = html();
        expect(page).toContain("isLocked(name) ? 'Unlock' : 'Lock'");
        expect(page).toContain('lock.toggle(name, node)');
        // Both directions run through the ONE WpNodeLock instance the page holds.
        expect(page).toContain('new WpNodeLock');
        expect(page).toContain('class WpNodeLock');
    });

    it('locks by dimming every other box and lighting the locked one, with the shared dim css', () => {
        const page = html();
        // The lock adds wp-dim to the svg and wp-focus to the node...
        expect(page).toContain("classList.add('wp-dim')");
        expect(page).toContain("classList.add('wp-focus')");
        // ...and unlocking takes both back off, restoring the "show all" view.
        expect(page).toContain("classList.remove('wp-dim')");
        // The css that makes those classes mean something, scoped to this page's graph host.
        expect(page).toContain('#graph svg.wp-dim .node');
        expect(page).toContain('#graph svg.wp-dim .node.wp-focus');
    });

    it('offers NO View Design item — runtime nodes are not nx projects, so it is absent, not dead', () => {
        const page = html();
        // The architecture page builds its item as new WpNodeMenuItem('View Design', ...) — that
        // exact spelling is what must be absent here (the prose in the client's docstring, which
        // explains WHY it is absent, deliberately is not it).
        expect(page).not.toContain("'View Design'");
        expect(page).not.toContain('__DESIGN_LINKS__');
    });

    it("has no lock dropdown, so the menu is the page's only lock control", () => {
        const page = html();
        expect(page).not.toContain('wp-lock');
        expect(page).toContain('<strong>Lock</strong>');
    });

    it('still renders the graph and reshapes the queues alongside the menu', () => {
        const page = html();
        expect(page).toContain('QueueCylinders');
        expect(page).toContain(JSON.stringify(DOT));
    });
});
