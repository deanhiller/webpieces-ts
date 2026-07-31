/*
 * Browser-side script for tmp/webpieces/runtime-architecture.html (inlined into a <script> tag by
 * runtime-visualizer.ts, which replaces the __DOT__ placeholder with the JSON-encoded DOT). Kept as
 * a plain .js asset — NOT a TypeScript template literal — matching graph-visualizer.client.js, so
 * ordinary browser functions can be declared without tripping the lint rules that scan .ts template
 * strings. Copied into dist by the build's client-js assets glob and read via readFileSync.
 * (Do not write that glob pattern out here: its slash-star sequence would close this comment early
 * and turn the rest of the file into a syntax error — which is exactly what happened once.)
 *
 * Two jobs:
 *   1. render the DOT with @viz-js/viz v3 (instance() resolves the WASM renderer, and
 *      renderSVGElement is then SYNCHRONOUS — v2's returned a promise);
 *   2. upgrade every queue node into a TRUE horizontal cylinder.
 *
 * Why (2) exists as post-processing rather than as a shape:
 *
 * Graphviz has exactly one `cylinder` and it is upright-only. `orientation=` is documented as
 * rotating POLYGON shapes, and `cylinder` is drawn with beziers, so it silently ignores the
 * attribute — graphviz issue #2244, open since 2022 and still reproducible on Graphviz 15, the
 * version this page's renderer carries. All 54 native shapes were compared at the real label size;
 * none is a horizontal cylinder. So the DOT emits `Mrecord` (which renders sensibly on its own, for
 * anyone running `dot` over the committed .dot file) and this script redraws it in the browser,
 * where the geometry can be computed from each node's actual bounding box and therefore fits any
 * label width — the thing a fixed image asset can never do.
 */
(function () {
    var dot = __DOT__;

    /** Cap width as a fraction of the node's half-height. Below ~0.6 it reads as a rounded box. */
    var CAP_RATIO = 0.75;
    /** A node narrower than this is not a queue box worth reshaping. */
    var MIN_WIDTH = 40;

    Viz.instance()
        .then(function (viz) {
            var element = viz.renderSVGElement(dot);
            makeQueuesCylindrical(element);
            document.getElementById('graph').appendChild(element);
        })
        .catch(function (err) {
            console.error(err);
            document.getElementById('graph').innerHTML = '<pre>' + err + '</pre>';
        });

    /**
     * Redraw every node the DOT marked `wp_queue` as a cylinder lying on its side.
     *
     * Selected by CLASS, not by id prefix: a queue-kind external system shares the `system__` id
     * space with databases, and a database is an UPRIGHT cylinder that must be left alone.
     */
    function makeQueuesCylindrical(svg) {
        var nodes = svg.querySelectorAll('g.wp_queue');
        for (var i = 0; i < nodes.length; i++) reshape(nodes[i]);
    }

    /**
     * Replace one node's shape elements with a horizontal cylinder sized to its own bounding box.
     *
     * The bbox is measured from the shape elements BEFORE they are removed, never from getBBox() on
     * the whole group — the group includes the text, which is inset, so using it would shrink the
     * cylinder inside the label it is meant to contain.
     */
    function reshape(node) {
        var shapes = node.querySelectorAll('polygon, path, polyline');
        if (!shapes.length) return;
        var box = boundsOf(shapes);
        if (!box || box.x1 - box.x0 < MIN_WIDTH) return;

        var first = shapes[0];
        var fill = first.getAttribute('fill') || 'none';
        var stroke = first.getAttribute('stroke') || 'black';
        for (var i = 0; i < shapes.length; i++) shapes[i].remove();

        var ry = (box.y1 - box.y0) / 2;
        var rx = Math.max(6, ry * CAP_RATIO);
        var body =
            'M' + (box.x0 + rx) + ',' + box.y0 +
            ' L' + (box.x1 - rx) + ',' + box.y0 +
            ' A' + rx + ',' + ry + ' 0 0 1 ' + (box.x1 - rx) + ',' + box.y1 +
            ' L' + (box.x0 + rx) + ',' + box.y1 +
            ' A' + rx + ',' + ry + ' 0 0 1 ' + (box.x0 + rx) + ',' + box.y0 + ' Z';
        // Only the NEAR end cap is drawn: that single arc is what reads as "tube" rather than
        // "stadium", and a real cylinder hides the far one behind the body.
        var cap =
            'M' + (box.x0 + rx) + ',' + box.y0 +
            ' A' + rx + ',' + ry + ' 0 0 1 ' + (box.x0 + rx) + ',' + box.y1;

        node.insertBefore(pathEl(fill, stroke, body), node.firstChild.nextSibling);
        node.insertBefore(pathEl('none', stroke, cap), node.firstChild.nextSibling.nextSibling);

        // The label is deliberately NOT nudged. QUEUE_LABEL_PREFIX already gives the node an empty
        // leading record field, so Graphviz has centred the text in the space to the RIGHT of where
        // the cap lands. Shifting it again double-counts that offset and pushes the longest line out
        // through the far end of the cylinder.
    }

    /** The union bounding box of some SVG shape elements, from their raw geometry attributes. */
    function boundsOf(shapes) {
        var xs = [], ys = [];
        for (var i = 0; i < shapes.length; i++) {
            var pts = shapes[i].getAttribute('points');
            var nums = pts ? pts.match(/-?[\d.]+/g) : (shapes[i].getAttribute('d') || '').match(/-?[\d.]+/g);
            if (!nums) continue;
            for (var n = 0; n + 1 < nums.length; n += 2) {
                xs.push(parseFloat(nums[n]));
                ys.push(parseFloat(nums[n + 1]));
            }
        }
        if (!xs.length) return null;
        return {
            x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
            y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
        };
    }

    function pathEl(fill, stroke, d) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.setAttribute('fill', fill);
        el.setAttribute('stroke', stroke);
        el.setAttribute('d', d);
        return el;
    }
})();
