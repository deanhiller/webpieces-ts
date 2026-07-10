/*
 * Browser-side script for architecture/dependencies.html (inlined into a <script>
 * tag by graph-visualizer.ts, which replaces the __DOT__ placeholder with the
 * JSON-encoded Graphviz DOT). Kept as a plain .js asset — NOT a TypeScript
 * template literal — so the dim/highlight/lock logic can define ordinary browser
 * functions without tripping the TypeScript lint rules that scan .ts template
 * strings. Copied into dist by the build's assets glob and read via readFileSync.
 *
 * After viz.js renders the SVG, wireHoverHighlight indexes nodes/edges and:
 *   - hovering a box dims the rest and lights its full ancestor+descendant chain;
 *   - the #wp-lock dropdown LOCKS one box's chain (dim persists on mouse-leave)
 *     and filters the responsibilities cards below the graph to just that chain.
 *     "All" (empty value) clears the lock and shows every card.
 */
(function () {
    var dot = __DOT__;
    var viz = new Viz();
    viz.renderSVGElement(dot)
        .then(function (element) {
            document.getElementById('graph').appendChild(element);
            wireHoverHighlight(element);
        })
        .catch(function (err) {
            console.error(err);
            document.getElementById('graph').innerHTML = '<pre>' + err + '</pre>';
        });

    function wireHoverHighlight(svg) {
        var nodeByName = new Map();
        svg.querySelectorAll('g.node').forEach(function (g) {
            var t = g.querySelector('title');
            if (t) nodeByName.set(t.textContent.trim(), g);
        });
        // Directed adjacency: in* = entering (up/ancestors), out* = leaving (down/deps).
        var inEdges = new Map(), outEdges = new Map(), inNodes = new Map(), outNodes = new Map();
        function ensure(map, key) {
            var v = map.get(key);
            if (!v) { v = new Set(); map.set(key, v); }
            return v;
        }
        svg.querySelectorAll('g.edge').forEach(function (edge) {
            var t = edge.querySelector('title');
            if (!t) return;
            var idx = t.textContent.indexOf('->');
            if (idx < 0) return;
            var from = t.textContent.slice(0, idx).trim();
            var to = t.textContent.slice(idx + 2).trim();
            ensure(outEdges, from).add(edge);
            ensure(inEdges, to).add(edge);
            ensure(outNodes, from).add(to);
            ensure(inNodes, to).add(from);
        });
        function clear() {
            svg.classList.remove('wp-dim');
            svg.querySelectorAll('.wp-focus, .wp-neighbor, .wp-hl').forEach(function (el) {
                el.classList.remove('wp-focus', 'wp-neighbor', 'wp-hl');
            });
        }
        function highlight(name, focusEl) {
            clear();
            svg.classList.add('wp-dim');
            focusEl.classList.add('wp-focus');
            // Transitively light ancestors (up) then descendants (down): edges
            // reached -> wp-hl, boxes -> wp-neighbor. visited guards cycles.
            [[inNodes, inEdges], [outNodes, outEdges]].forEach(function (dir) {
                var visited = new Set();
                var stack = [name];
                while (stack.length) {
                    var cur = stack.pop();
                    (dir[1].get(cur) || []).forEach(function (e) { e.classList.add('wp-hl'); });
                    (dir[0].get(cur) || []).forEach(function (next) {
                        if (visited.has(next)) return;
                        visited.add(next);
                        stack.push(next);
                        var g = nodeByName.get(next);
                        if (g) g.classList.add('wp-neighbor');
                    });
                }
            });
        }
        // locked = the box the dropdown pinned (or null). Hover still works on top
        // of a lock; leaving a box restores the locked view instead of clearing, so
        // the pinned subgraph stays visible as you scroll to its responsibilities.
        var locked = null;
        function relight() {
            if (locked) {
                var lg = nodeByName.get(locked);
                if (lg) highlight(locked, lg);
            } else {
                clear();
            }
        }
        nodeByName.forEach(function (g, name) {
            g.addEventListener('mouseenter', function () { highlight(name, g); });
            g.addEventListener('mouseleave', relight);
        });

        // Filter the responsibilities cards to the locked box's chain by reading the
        // .wp-focus/.wp-neighbor classes highlight() just set — no second graph walk.
        var lockSelect = document.getElementById('wp-lock');
        function filterCards() {
            var lit = new Set();
            if (locked) {
                svg.querySelectorAll('.wp-focus, .wp-neighbor').forEach(function (el) {
                    var t = el.querySelector('title');
                    if (t) lit.add(t.textContent.trim());
                });
            }
            document.querySelectorAll('.wp-resp-card').forEach(function (card) {
                var nm = card.getAttribute('data-node');
                card.classList.toggle('wp-hidden', !(!locked || lit.has(nm)));
            });
        }
        if (lockSelect) {
            lockSelect.addEventListener('change', function () {
                locked = lockSelect.value || null;
                if (locked) {
                    var g = nodeByName.get(locked);
                    if (g) highlight(locked, g);
                } else {
                    clear();
                }
                filterCards();
            });
        }
    }
})();
