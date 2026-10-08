import { STRIPED_CLASS } from './graph-color-modes';

/**
 * The architecture page's stylesheet: the dark drawer, the graph filling the viewport, the floating
 * popovers and the responsibilities panel. Emitted AFTER the shared menu/filter/navigation styles so
 * its `#graph` rules (fill the viewport, no 75vh cap) win.
 */
export class GraphPageStyles {
    css(): string {
        return (
            this.base() +
            this.drawer() +
            this.controls() +
            this.main() +
            this.overlays() +
            this.filterPopover() +
            this.graph() +
            this.cards()
        );
    }

    private base(): string {
        return `
        :root {
            --wp-side-bg: #15161b; --wp-side-control: #1e1f25; --wp-side-fg: #e9eaf0; --wp-side-muted: #8b8fa0;
            --wp-side-hover: #26272f; --wp-side-line: #3a3c46; --wp-accent: #8b3cf0; --wp-accent-hover: #a46bf7;
            --wp-fg: #1b1e27; --wp-muted: #5d6475; --wp-line: #d9dce5; --wp-surface: #ffffff; --wp-canvas: #faf9f5;
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
        .wp-pulldown { position: relative; }
        .wp-pill-trigger { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 10px;
            width: 100%; padding: 7px 16px; border-radius: 999px; border: 1px solid var(--wp-side-line);
            background: var(--wp-side-control); }
        .wp-pill-trigger:hover, .wp-pill-trigger[aria-expanded="true"] { border-color: var(--wp-accent-hover); }
        .wp-pill-text { flex: 1 1 auto; min-width: 0; }
        .wp-caret { color: var(--wp-side-muted); }
        .wp-menu { position: absolute; z-index: 35; left: 0; right: 0; top: calc(100% + 6px); display: grid; gap: 2px; padding: 6px;
            background: var(--wp-side-control); border: 1px solid var(--wp-side-line); border-radius: 12px; box-shadow: 0 10px 28px #0008; }
        .wp-mode { all: unset; box-sizing: border-box; cursor: pointer; display: block; padding: 6px 10px; border-radius: 8px; }
        .wp-mode:hover { background: var(--wp-side-hover); }
        .wp-mode[aria-checked="true"] { background: #2a2333; box-shadow: inset 3px 0 0 var(--wp-accent); }
        .wp-mode:disabled { cursor: not-allowed; opacity: 0.45; }
        .wp-mode-name { display: block; font-size: 14px; font-weight: 600; line-height: 1.3; }
        .wp-mode-sub { display: block; font-size: 12px; color: var(--wp-side-muted); line-height: 1.3; }
        .wp-filter-btn { all: unset; box-sizing: border-box; cursor: pointer; display: flex; justify-content: space-between;
            align-items: center; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--wp-side-line);
            background: var(--wp-side-control); font-size: 13px; font-weight: 600; }
        .wp-filter-btn:hover, .wp-filter-btn[aria-expanded="true"] { border-color: var(--wp-accent-hover); }
        .wp-badge { min-width: 18px; padding: 1px 6px; border-radius: 999px; background: var(--wp-accent); color: #fff;
            font-size: 11.5px; text-align: center; box-sizing: border-box; }
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
        .wp-side input[type="search"] { width: 100%; box-sizing: border-box; background: var(--wp-side-control); color: var(--wp-side-fg);
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
        .wp-mode:focus-visible, .wp-pill-trigger:focus-visible, .wp-filter-btn:focus-visible, .wp-chip:focus-visible,
        .wp-primary:focus-visible, .wp-pill button:focus-visible, .wp-toggle:focus-visible, .wp-side input:focus-visible, .wp-icon:focus-visible,
        .wp-link:focus-visible { outline: 2px solid var(--wp-accent-hover); outline-offset: 2px; }`;
    }

    private main(): string {
        return `
        .wp-main { position: relative; min-width: 0; height: 100vh; display: flex; flex-direction: column; }
        .wp-topbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 12px;
            border-bottom: 1px solid var(--wp-line); background: var(--wp-surface); }
        .wp-crumb { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--wp-muted); overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        .wp-crumb b { color: var(--wp-fg); }
        .wp-topbar #wp-filter-status, .wp-topbar #wp-graph-error { margin: 0; font-size: 13px; }
        .wp-pills { display: flex; gap: 6px; flex-wrap: wrap; }
        .wp-pills:empty { display: none; }
        .wp-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; border-radius: 999px;
            background: #f1e8fe; color: #4a1d8a; border: 1px solid #d6bcfa; font-size: 12.5px; }
        .wp-pill button { all: unset; cursor: pointer; width: 18px; height: 18px; display: inline-grid; place-items: center;
            border-radius: 50%; color: #4a1d8a; }
        .wp-pill button:hover { background: #e2cffc; }`;
    }

    /** The Filter popover: three groups, chips, and the "Show N projects" footer. */
    private filterPopover(): string {
        return `
        .wp-filter-pop { left: 12px; top: 56px; width: min(380px, calc(100% - 24px)); max-height: calc(100% - 80px); overflow: auto; }
        .wp-fgroup { border: 0; margin: 0 0 12px; padding: 0; display: grid; gap: 4px; }
        .wp-fgroup legend { padding: 0; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
            color: var(--wp-muted); font-weight: 600; }
        .wp-fgroup legend small { text-transform: none; letter-spacing: 0; font-weight: 400; }
        .wp-fgroup:disabled .wp-scope { opacity: 0.45; cursor: not-allowed; }
        .wp-scope { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
        .wp-scope:hover { background: #f4f1fb; }
        .wp-scope input { accent-color: var(--wp-accent); margin: 0; }
        .wp-scope-text { flex: 1 1 auto; display: grid; }
        .wp-scope-sub { font-size: 11.5px; color: var(--wp-muted); line-height: 1.3; }
        .wp-chip-swatch { vertical-align: -1px; margin-right: 5px; }
        .wp-count { color: var(--wp-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
        .wp-scope-reason { margin: 2px 6px 0; font-size: 12px; color: var(--wp-muted); }
        .wp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .wp-chip { all: unset; box-sizing: border-box; cursor: pointer; padding: 3px 11px; border-radius: 999px;
            border: 1px solid var(--wp-line); background: var(--wp-surface); font-size: 12.5px; }
        .wp-chip:hover { border-color: var(--wp-accent-hover); }
        .wp-chip[aria-pressed="true"] { background: var(--wp-accent); border-color: var(--wp-accent); color: #fff; }
        .wp-chip:disabled { opacity: 0.45; cursor: default; }
        .wp-impact-kinds { margin: 6px 0 4px; }
        .wp-side .wp-chip:not([aria-pressed="true"]) { background: var(--wp-side-control); border-color: var(--wp-side-line); }
        .wp-filter-pop footer { display: flex; justify-content: space-between; align-items: center; gap: 8px;
            padding-top: 10px; border-top: 1px solid var(--wp-line); }
        .wp-text-btn { all: unset; cursor: pointer; color: var(--wp-muted); font-size: 12.5px; text-decoration: underline; }
        .wp-primary { all: unset; box-sizing: border-box; cursor: pointer; padding: 7px 14px; border-radius: 8px;
            background: var(--wp-accent); color: #fff; font-weight: 600; font-size: 13px; }
        .wp-primary:hover { background: var(--wp-accent-hover); }`;
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
     * The graph fills what the topbar leaves.
     *
     * The hover glow and the lock outline belong to the OUTER box only. A nested Runtime box (one
     * runtime plus a specialization) is an HTML-like table, so after the node's own outline Graphviz
     * emits a `<polygon>` for the base-colored cell and a `<path>` for the inner `STYLE="rounded"`
     * table — matching only `polygon` here is what let the glow stroke the inner box (#1158). So the
     * glow is suppressed on EVERY shape after the node's first, whatever its element type.
     *
     * A striped (multi-runtime) box is the one exception to "the first shape is the outline":
     * Graphviz draws one filled polygon per stripe first and the outline LAST, as an unfilled polygon.
     * graph-color-modes.ts stamps those boxes `wp-striped`, and for them the outline is that last,
     * `fill="none"` polygon; the stripes keep their thin dividers.
     */
    private graph(): string {
        const shape = ':is(polygon, ellipse, path)';
        const later = `${shape} ~ ${shape}`;
        const first = `${shape}:not(${later})`;
        const glow = 'stroke: var(--wp-accent); stroke-width: 5; filter: drop-shadow(0 0 6px rgba(139, 60, 240, 0.85));';
        return `
        #graph { flex: 1 1 auto; min-height: 0; max-height: none; overflow: auto; padding: 16px 16px 64px;
            box-sizing: border-box; background: var(--wp-canvas); }
        #graph g.wp-node-clickable:hover > ${later} { stroke: none; stroke-width: 0; filter: none; }
        #graph g.wp-node-clickable.${STRIPED_CLASS}:hover > polygon:not([fill="none"]) { stroke: #000000; stroke-width: 0.5; filter: none; }
        #graph g.wp-node-clickable.${STRIPED_CLASS}:hover > polygon[fill="none"] { ${glow} }
        #graph g.node.wp-locked:not(.${STRIPED_CLASS}) > ${first},
        #graph g.node.wp-locked.${STRIPED_CLASS} > polygon[fill="none"] { stroke: var(--wp-accent); stroke-width: 3; }`;
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
