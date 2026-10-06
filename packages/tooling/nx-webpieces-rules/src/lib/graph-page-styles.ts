/**
 * The architecture page's stylesheet: the dark drawer, the graph filling the viewport, the floating
 * popovers and the responsibilities panel. Emitted AFTER the shared menu/filter/navigation styles so
 * its `#graph` rules (fill the viewport, no 75vh cap) win.
 */
export class GraphPageStyles {
    css(): string {
        return this.base() + this.drawer() + this.controls() + this.main() + this.overlays() + this.graph() + this.cards();
    }

    private base(): string {
        return `
        :root {
            --wp-side-bg: #0c0d12; --wp-side-fg: #e9eaf0; --wp-side-muted: #8b8fa0;
            --wp-side-hover: #1f2129; --wp-side-line: #2a2c36; --wp-accent: #3559d6; --wp-accent-dark: #8aa4ff;
            --wp-fg: #1b1e27; --wp-muted: #5d6475; --wp-line: #d9dce5; --wp-surface: #ffffff; --wp-canvas: #fbfbfd;
        }
        html, body { height: 100%; }
        /* A class that sets display (the legend lists are grids) must not un-hide a [hidden] element. */
        [hidden] { display: none !important; }
        body { margin: 0; padding: 0; overflow: hidden; background: var(--wp-canvas); color: var(--wp-fg);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 14px; }
        kbd { font-family: ui-monospace, Menlo, monospace; font-size: 12px; border: 1px solid var(--wp-line);
            border-radius: 4px; padding: 0 5px; background: #f3f4f7; }
        .wp-shell { display: grid; grid-template-columns: 272px minmax(0, 1fr); height: 100vh; }
        .wp-shell.wp-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
        .wp-shell.wp-collapsed .wp-side { visibility: hidden; }
        @media (max-width: 760px) {
            .wp-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, auto) minmax(0, 1fr); }
            .wp-side { max-height: 42vh; }
            .wp-shell.wp-collapsed { grid-template-columns: minmax(0, 1fr); }
            .wp-shell.wp-collapsed .wp-side { display: none; }
            .wp-main { height: auto; min-height: 0; }
        }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`;
    }

    private drawer(): string {
        return `
        .wp-side { background: var(--wp-side-bg); color: var(--wp-side-fg); overflow-y: auto; overflow-x: hidden;
            display: flex; flex-direction: column; padding: 12px 0 10px; min-width: 0; font-size: 13px; }
        .wp-brand { display: flex; align-items: center; gap: 10px; padding: 0 16px 10px; font-weight: 600; font-size: 14px; }
        .wp-brand svg { flex: none; }
        .wp-group { padding: 8px 14px; border-top: 1px solid var(--wp-side-line); display: grid; gap: 6px; }
        .wp-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--wp-side-muted);
            font-weight: 600; padding-left: 4px; }
        .wp-label-row { display: flex; justify-content: space-between; align-items: center; }
        .wp-modes { display: grid; gap: 1px; }
        .wp-mode { all: unset; box-sizing: border-box; cursor: pointer; display: block; padding: 5px 10px; border-radius: 8px; }
        .wp-mode:hover { background: var(--wp-side-hover); }
        .wp-mode[aria-pressed="true"] { background: #262833; box-shadow: inset 3px 0 0 var(--wp-accent-dark); }
        .wp-mode:disabled { cursor: not-allowed; opacity: 0.45; }
        .wp-mode-name { display: block; font-size: 14px; font-weight: 600; line-height: 1.3; }
        .wp-mode-sub { display: block; font-size: 12px; color: var(--wp-side-muted); line-height: 1.3; }
        .wp-mode-reason { margin: 2px 4px 0; font-size: 11.5px; line-height: 1.35; color: var(--wp-side-muted); }
        .wp-legend-list { display: grid; gap: 5px; padding-left: 4px; }
        .wp-legend-row { display: flex; align-items: center; gap: 10px; line-height: 1.25; }
        .wp-legend-row svg { flex: none; }
        .wp-legend-row small { display: block; color: var(--wp-side-muted); font-size: 11.5px; }
        .wp-impact-note { margin: 2px 0 0; font-size: 11.5px; color: var(--wp-side-muted); }
        .wp-impact-note:empty { display: none; }
        .wp-foot { margin-top: auto; padding: 10px 18px 0; border-top: 1px solid var(--wp-side-line); display: flex; gap: 14px; flex-wrap: wrap; }`;
    }

    private controls(): string {
        return `
        .wp-side input[type="search"] { width: 100%; box-sizing: border-box; background: #17181f; color: var(--wp-side-fg);
            border: 1px solid var(--wp-side-line); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; }
        .wp-toggle { all: unset; box-sizing: border-box; cursor: pointer; display: flex; justify-content: space-between;
            align-items: center; padding: 6px 10px; border-radius: 8px; font-size: 13px; }
        .wp-toggle:hover { background: var(--wp-side-hover); }
        .wp-toggle:disabled { cursor: not-allowed; opacity: 0.45; }
        .wp-sw { width: 30px; height: 18px; border-radius: 9px; background: #3a3d4a; position: relative; transition: background 0.15s; }
        .wp-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
            background: #fff; transition: transform 0.15s; }
        .wp-toggle[aria-pressed="true"] .wp-sw { background: var(--wp-accent); }
        .wp-toggle[aria-pressed="true"] .wp-sw::after { transform: translateX(12px); }
        .wp-link { all: unset; cursor: pointer; color: var(--wp-side-muted); font-size: 12px; text-decoration: underline; }
        .wp-link:hover { color: var(--wp-side-fg); }
        .wp-icon { all: unset; box-sizing: border-box; cursor: pointer; display: inline-grid; place-items: center; flex: none;
            width: 34px; height: 34px; border-radius: 8px; background: var(--wp-surface); border: 1px solid var(--wp-line);
            color: var(--wp-fg); font-size: 15px; }
        .wp-icon:hover { border-color: var(--wp-accent); }
        .wp-icon-mini { width: 24px; height: 24px; font-size: 12px; }
        .wp-icon-dark { background: transparent; border-color: var(--wp-side-line); color: var(--wp-side-fg); }
        .wp-mode:focus-visible, .wp-toggle:focus-visible, .wp-side input:focus-visible, .wp-icon:focus-visible,
        .wp-link:focus-visible { outline: 2px solid var(--wp-accent-dark); outline-offset: 2px; }`;
    }

    private main(): string {
        return `
        .wp-main { position: relative; min-width: 0; height: 100vh; display: flex; flex-direction: column; }
        .wp-topbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 12px;
            border-bottom: 1px solid var(--wp-line); background: var(--wp-surface); }
        .wp-crumb { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--wp-muted); overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        .wp-crumb b { color: var(--wp-fg); }
        .wp-topbar #wp-filter-status, .wp-topbar #wp-graph-error { margin: 0; font-size: 13px; }`;
    }

    private overlays(): string {
        return `
        .wp-pop { position: absolute; z-index: 30; background: var(--wp-surface); border: 1px solid var(--wp-line);
            border-radius: 10px; box-shadow: 0 8px 24px #0002; padding: 12px 14px; font-size: 13px; box-sizing: border-box; }
        .wp-pop header { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 8px; }
        .wp-legend-popout { left: 12px; bottom: 12px; width: 270px; max-height: 60vh; overflow: auto; }
        .wp-legend-popout .wp-legend-row small, .wp-legend-popout .wp-impact-note { color: var(--wp-muted); }
        .wp-help { right: 12px; top: 56px; width: min(380px, calc(100% - 24px)); line-height: 1.5; }
        .wp-help p { margin: 0 0 8px; }
        .wp-snapshot { left: 12px; bottom: 12px; width: min(440px, calc(100% - 24px)); }
        .wp-snapshot .hint { margin: 0; }
        .wp-panel { position: absolute; top: 0; right: 0; bottom: 0; z-index: 40; width: min(540px, 100%); box-sizing: border-box;
            overflow-y: auto; padding: 0 16px 16px; background: #f5f6f9; border-left: 1px solid var(--wp-line); box-shadow: -8px 0 24px #0002; }
        .wp-panel > header { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; align-items: center;
            padding: 12px 0; background: #f5f6f9; font-weight: 600; font-size: 15px; }`;
    }

    /**
     * The graph fills what the topbar leaves. A Runtime box with a specialization is an HTML-like
     * table, so its cells are extra polygons inside the node: the hover glow and the lock outline are
     * kept on the box's own outline (the FIRST polygon) instead of stroking every cell.
     */
    private graph(): string {
        return `
        #graph { flex: 1 1 auto; min-height: 0; max-height: none; overflow: auto; padding: 16px 16px 64px;
            box-sizing: border-box; background: var(--wp-canvas); }
        #graph g.wp-node-clickable:hover polygon:not(:first-of-type) { stroke: transparent; stroke-width: 0; filter: none; }
        #graph g.node.wp-locked > polygon:first-of-type,
        #graph g.node.wp-locked > ellipse,
        #graph g.node.wp-locked > path { stroke: #b26a00; stroke-width: 3; }`;
    }

    private cards(): string {
        return `
        #wp-responsibilities { margin: 0; }
        #wp-responsibilities > h2 { display: none; }
        #wp-responsibilities > .hint { color: var(--wp-muted); margin: 0 0 8px; }
        .wp-resp-card { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin: 10px 0; padding: 10px 15px; }
        .wp-resp-card > summary { cursor: pointer; color: #333; }
        .wp-resp-level { display: inline-block; min-width: 26px; padding: 1px 6px; margin-right: 6px; border-radius: 4px;
            background: #eef; font-size: 12px; font-weight: bold; text-align: center; }
        .wp-resp-body { margin-top: 8px; color: #444; }
        .wp-resp-body code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-family: monospace; }
        .wp-hidden { display: none; }`;
    }
}
