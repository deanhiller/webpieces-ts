/**
 * Where the zoom controls sit. The runtime page keeps its toolbar ABOVE the graph; the architecture
 * page gives the graph the whole viewport and floats a compact `− 1:1 ⤢ +` cluster bottom-right.
 */
export enum NavigationLayout {
    TOOLBAR = 'toolbar',
    FLOATING = 'floating',
}

/** Shared local-file navigation. Reset restores readable scale; Fit is an explicit overview. */
export class GraphNavigation {
    constructor(private readonly layout: NavigationLayout) {}

    styles(): string {
        return `
        #graph { overflow: auto; max-height: 75vh; text-align: left; touch-action: pan-x pan-y; }
        #graph svg { max-width: none; max-height: none; display: block; }
        .wp-navigation { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
        .wp-navigation button { padding: 6px 12px; cursor: pointer; }
        .wp-navigation.wp-zoom { position: absolute; right: 14px; bottom: 14px; margin: 0; gap: 6px; z-index: 20; }
        .wp-navigation.wp-zoom button { min-width: 34px; height: 34px; padding: 0 8px; border-radius: 8px; border: 1px solid #d9dce5; background: #fff; color: #1b1e27; font-size: 15px; }
        .wp-navigation.wp-zoom button:hover { border-color: #3559d6; }
        .wp-navigation.wp-zoom output { min-width: 42px; padding: 2px 6px; border-radius: 6px; background: #ffffffd9; color: #5d6475; font-size: 12px; text-align: center; }
        .wp-graph-details { position: fixed; z-index: 1100; box-sizing: border-box; max-width: min(520px, calc(100vw - 24px)); max-height: min(480px, calc(100vh - 24px)); overflow: auto; background: white; padding: 12px; border: 1px solid #aaa; border-radius: 6px; box-shadow: 0 4px 16px #0003; font: 14px/1.5 Arial, sans-serif; overflow-wrap: anywhere; }
        .wp-graph-details li { margin-bottom: 8px; }
        .wp-api-detail { cursor: pointer; text-decoration: underline; }
        .wp-api-detail:focus { outline: 2px solid #1565c0; }
        `;
    }

    script(): string {
        const floating = this.layout === NavigationLayout.FLOATING;
        return `new (${GraphNavigationController.toString()})(${JSON.stringify(floating)});`;
    }
}

/** Serialized browser controller; dependencies are native DOM APIs only. */
class GraphNavigationController {
    private readonly host = document.getElementById('graph');
    private readonly toolbar = document.createElement('nav');
    private readonly status = document.createElement('output');
    private svg: SVGSVGElement | null = null;
    private scale = 1;

    constructor(floating: boolean) {
        if (this.host === null) return;
        this.toolbar.className = floating ? 'wp-navigation wp-zoom' : 'wp-navigation';
        this.toolbar.setAttribute('aria-label', 'Graph navigation');
        if (floating) this.floatingButtons();
        else this.toolbarButtons();
        new MutationObserver(() => this.attach()).observe(this.host, { childList: true });
        this.attach();
        window.addEventListener('resize', () => this.changed());
        this.host.addEventListener('scroll', () => this.changed());
    }

    private toolbarButtons(): void {
        this.host?.before(this.toolbar);
        this.button('Zoom in', 'Zoom in', () => this.zoom(1.25));
        this.button('Zoom out', 'Zoom out', () => this.zoom(0.8));
        this.button('Readable reset', 'Readable reset', () => this.reset());
        this.button('Fit overview', 'Fit overview', () => this.fit());
        this.toolbar.append(this.status);
    }

    /** Placed AFTER the graph in the DOM, so it never sits ahead of the boxes in the tab order. */
    private floatingButtons(): void {
        this.host?.after(this.toolbar);
        this.toolbar.append(this.status);
        this.button('−', 'Zoom out', () => this.zoom(0.8));
        this.button('1:1', 'Readable reset', () => this.reset());
        this.button('⤢', 'Fit overview', () => this.fit());
        this.button('+', 'Zoom in', () => this.zoom(1.25));
    }

    private button(text: string, label: string, action: () => void): void {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.title = label;
        button.setAttribute('aria-label', label);
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
