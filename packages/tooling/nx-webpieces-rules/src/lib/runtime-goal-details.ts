import type { RuntimeComparisonView } from './graph-render-model';

/** The before/after lines the page's Goal vs Current details panel shows, keyed by overlay id. */
export class RuntimeGoalDetailsData {
    constructor(
        public readonly nodes: Record<string, string[]>,
        public readonly edges: Record<string, string[]>,
    ) {}
}

/**
 * Goal vs Current details (#1239): the page script that opens before/after lines for a clicked box
 * (a "Goal vs Current" item in the SHARED node menu) or a clicked arrow, while that mode is on.
 * Inlined with toString, like RuntimeDetails, so the page works from `file://` with no fetch.
 */
export class RuntimeGoalDetails {
    constructor(private readonly comparison: RuntimeComparisonView | null) {}

    script(): string {
        const data = new RuntimeGoalDetailsData(this.comparison?.nodeDetails ?? {}, this.comparison?.edgeDetails ?? {});
        const encoded = JSON.stringify(data).replace(/</g, '\\u003c');
        return `window.__WP_GOAL__ = new (${RuntimeGoalDetailsController.toString()})(${encoded});`;
    }
}

/** Browser controller: one floating panel, rebound to each redrawn overlay SVG. */
class RuntimeGoalDetailsController {
    private readonly host = document.getElementById('graph');
    private readonly panel = document.createElement('div');
    private anchor: Element | null = null;

    constructor(private readonly data: RuntimeGoalDetailsData) {
        this.panel.className = 'wp-goal-details';
        this.panel.hidden = true;
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', 'Goal vs Current details');
        document.body.append(this.panel);
        if (this.host !== null) new MutationObserver(() => this.attach()).observe(this.host, { childList: true });
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !this.panel.hidden) {
                event.stopPropagation();
                this.close();
            }
        });
        document.addEventListener('click', (event: MouseEvent) => {
            if (event.target instanceof Node && !this.panel.contains(event.target) && !this.anchor?.contains(event.target)) this.close();
        });
    }

    /** The node menu's item, only while Goal vs Current is the active mode and the box has details. */
    item(name: string, node: SVGGElement): WpNodeMenuItem | null {
        if (!this.active() || this.data.nodes[name] === undefined) return null;
        return new WpNodeMenuItem('Goal vs Current details', () => this.open(node, this.data.nodes[name]));
    }

    private active(): boolean {
        return document.body.dataset['wpMode'] === 'goal';
    }

    /** Every overlay arrow opens its relationship's before/after lines (capture: ahead of the Uses popup). */
    private attach(): void {
        this.close();
        if (!this.active() || this.host === null) return;
        for (const group of Array.from(this.host.querySelectorAll<SVGGElement>('g.edge'))) {
            const lines = this.data.edges[group.id];
            if (lines === undefined || group.dataset['wpGoal'] === 'true') continue;
            group.dataset['wpGoal'] = 'true';
            group.classList.add('wp-goal-edge');
            group.setAttribute('tabindex', '0');
            group.setAttribute('role', 'button');
            group.setAttribute('aria-label', `Goal vs Current: ${lines[0]}`);
            group.addEventListener('click', (event: MouseEvent) => {
                event.stopPropagation();
                this.open(group, lines);
            }, true);
            group.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this.open(group, lines);
            });
        }
    }

    private open(anchor: Element, lines: string[]): void {
        this.anchor = anchor;
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.onclick = () => this.close();
        const title = document.createElement('p');
        title.textContent = 'Current → Goal';
        const list = document.createElement('ul');
        for (const line of lines.length === 0 ? ['Unchanged: present in both saved files with the same facts.'] : lines) {
            const item = document.createElement('li');
            item.textContent = line;
            list.append(item);
        }
        this.panel.replaceChildren(close, title, list);
        this.panel.hidden = false;
        const rect = anchor.getBoundingClientRect();
        this.panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - this.panel.offsetWidth - 12))}px`;
        this.panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - this.panel.offsetHeight - 12))}px`;
        close.focus({ preventScroll: true });
    }

    private close(): void {
        this.panel.hidden = true;
        this.anchor = null;
    }
}
