# The queue node still does not read as a cylinder — explore a packaged image asset

**Package:** `@webpieces/nx-webpieces-rules`
**Severity:** Low — cosmetic. The shape is unambiguous against every other node on the graph; it
just is not the shape it is meant to evoke.

## Symptom

The runtime graph draws a queue as `shape=Mrecord` with an empty leading field:

```dot
"queue__TaskApi_send" [shape=Mrecord, style="filled", fillcolor="#FFF3E0",
                       label=" |TaskApi.send\nqueue: TaskApi-send"];
```

The intent is a **cylinder lying on its side** — the conventional "message queue" glyph, deliberately
distinct from the upright cylinder that now means a database. What actually renders is a rounded
rectangle with a short vertical line near its left edge. With a two-line queue label the box is tall
enough that the corner radius reads as a mild rounding rather than as the end of a tube, so it looks
like a box with a tab, not a cylinder.

It is *correct* — no other node on the graph looks like it — but it does not carry the meaning it was
chosen to carry.

## Why the obvious fix does not work

`orientation=90` on `shape=cylinder` is the natural answer and it silently does nothing. The
attribute is documented as rotating **polygon** node shapes, and `cylinder` is drawn with beziers, so
it is skipped. This is a known, still-open Graphviz bug:

- https://gitlab.com/graphviz/graphviz/-/issues/2244 — *"Orientation" doesn't work when shape type is
  cylinder* (filed June 2022, no fix, no milestone)

Verified empirically: rendering the same node at `orientation=0` and `orientation=90` on **Graphviz
13.0.0** produces byte-identical SVG. `hexagon` and `box3d` DO rotate, confirming the polygon-only
rule rather than a broken build. Upgrading Graphviz does not fix this — the in-browser renderer is
now `@viz-js/viz@3.28.0`, which carries Graphviz 15, and the limitation is unchanged.

All 54 native Graphviz shapes were rendered at the real label size and compared; none is a horizontal
cylinder. `Mrecord` was the closest available and was shipped as the interim.

## Options to evaluate

1. **A packaged image asset.** Draw the sideways cylinder once as SVG, ship it inside the
   `@webpieces/nx-webpieces-rules` package, and reference it with `image=` / `shape=none`.
   - Blocker to solve first: the graph is rendered by **viz.js/WASM in the browser**, where there is
     no filesystem. The asset would have to be inlined as a `data:` URI in the generated HTML, or
     copied next to it, and Graphviz needs the image's dimensions declared up front.
   - Harder problem: a queue label is two lines of variable width, and a fixed image cannot grow with
     it. Either the art stretches or the text overflows. A 9-slice / stretchable-middle approach, or
     computing per-node dimensions at generate time, would be needed.
2. **Post-process the rendered SVG.** ~25 lines of browser JS: find each `g.node` whose `<title>`
   starts with `queue__` and replace its `<path>`s with a horizontal cylinder computed from the
   node's bounding box. Scales perfectly with the label and needs no asset.
   - Cost: the written `.dot` still says `Mrecord`, so `dot -Tpng` on the raw file disagrees with the
     HTML. That divergence is why it was not chosen the first time.
3. **A custom Graphviz shape upstream.** Contribute an `hcylinder` shape, or a fix for #2244, to
   Graphviz. Correct in the long run, useless on any timescale that matters here.
4. **Accept `Mrecord` and lean on the legend.** The legend now carries a swatch of the actual shape
   beside the word "queue", which is what most readers will key off anyway.

## Where the code is

- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` — `QUEUE_SHAPE` and
  `QUEUE_LABEL_PREFIX` are the two constants that define the shape; `edgeDot()` emits the node, and
  `EXTERNAL_SHAPES` maps a declared `queue`-kind external to the same shape.
- `LegendSwatches.queue` in the same file draws the legend's hand-built version, which must be kept
  visually consistent with whatever the node ends up being.

Note `QUEUE_LABEL_PREFIX` depends on the graph being `rankdir=TB`: record fields lay out along the
rank direction, so adding `{}` or flipping rankdir rotates the cap line and breaks the shape.
