/** Shared local-file navigation. Reset restores readable scale; Fit is an explicit overview. */
export class GraphNavigation {
    styles(): string {
        return `
        #graph { overflow: auto; max-height: 75vh; text-align: left; touch-action: pan-x pan-y; }
        #graph svg { max-width: none; max-height: none; display: block; }
        .wp-navigation { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
        .wp-navigation button { padding: 6px 12px; cursor: pointer; }
        .wp-graph-details { position: fixed; z-index: 1100; box-sizing: border-box; max-width: min(520px, calc(100vw - 24px)); max-height: min(480px, calc(100vh - 24px)); overflow: auto; background: white; padding: 12px; border: 1px solid #aaa; border-radius: 6px; box-shadow: 0 4px 16px #0003; font: 14px/1.5 Arial, sans-serif; overflow-wrap: anywhere; }
        .wp-graph-details li { margin-bottom: 8px; }
        .wp-api-detail { cursor: pointer; text-decoration: underline; }
        .wp-api-detail:focus { outline: 2px solid #1565c0; }
        `;
    }

    script(): string {
        return `new (${GraphNavigationController.toString()})();`;
    }
}

/** Serialized browser controller; dependencies are native DOM APIs only. */
class GraphNavigationController {
    private readonly host = document.getElementById('graph');
    private readonly toolbar = document.createElement('nav');
    private readonly status = document.createElement('output');
    private svg: SVGSVGElement | null = null;
    private scale = 1;

    constructor() {
        if (this.host === null) return;
        this.toolbar.className = 'wp-navigation';
        this.toolbar.setAttribute('aria-label', 'Graph navigation');
        this.host.before(this.toolbar);
        this.button('Zoom in', () => this.zoom(1.25));
        this.button('Zoom out', () => this.zoom(0.8));
        this.button('Readable reset', () => this.reset());
        this.button('Fit overview', () => this.fit());
        this.toolbar.append(this.status);
        new MutationObserver(() => this.attach()).observe(this.host, { childList: true });
        this.attach();
        window.addEventListener('resize', () => this.changed());
        this.host.addEventListener('scroll', () => this.changed());
    }

    private button(label: string, action: () => void): void {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', action);
        this.toolbar.append(button);
    }

    private changed(): void {
        document.dispatchEvent(new Event('wp-graph-transform'));
    }

    private resize(): void {
        if (this.svg === null) return;
        const box = this.svg.viewBox.baseVal;
        this.svg.style.width = `${box.width * this.scale}px`;
        this.svg.style.height = `${box.height * this.scale}px`;
        this.status.textContent = `${Math.round(this.scale * 100)}%`;
        this.changed();
    }

    private zoom(factor: number): void {
        if (this.host === null) return;
        const before = this.scale;
        this.scale = Math.max(0.1, Math.min(4, this.scale * factor));
        const centerX = this.host.scrollLeft + this.host.clientWidth / 2;
        const centerY = this.host.scrollTop + this.host.clientHeight / 2;
        this.resize();
        this.host.scrollLeft = (centerX * this.scale) / before - this.host.clientWidth / 2;
        this.host.scrollTop = (centerY * this.scale) / before - this.host.clientHeight / 2;
    }

    private reset(): void {
        this.scale = 1;
        this.resize();
        this.scrollOrigin();
    }

    private scrollOrigin(): void {
        if (this.host === null) return;
        this.host.scrollLeft = 0;
        this.host.scrollTop = 0;
    }

    private fit(): void {
        if (this.svg === null || this.host === null) return;
        this.scale = Math.min(
            1,
            this.host.clientWidth / this.svg.viewBox.baseVal.width,
            this.host.clientHeight / this.svg.viewBox.baseVal.height,
        );
        this.resize();
        this.scrollOrigin();
    }

    private attach(): void {
        const next = this.host?.querySelector('svg');
        if (next === null || next === undefined || next === this.svg) return;
        this.svg = next;
        this.reset();
    }
}
