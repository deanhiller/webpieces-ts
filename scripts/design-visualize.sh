#!/bin/sh
# Open the DI design graph (the generated design.md constructor-injection DAG) for the projects
# YOU pick — the per-project companion to `arch:visualize` (which shows one combined graph).
# Prompts you to choose projects, then opens EACH chosen project's graph in its own browser tab.
#
# Usage:  pnpm design:visualize
#   At the prompt enter: space/comma-separated numbers (e.g. "1 4 7"), name substrings
#   (e.g. "server2 http"), "all", or blank to cancel. Non-interactive: `echo all | pnpm design:visualize`.
#
# design.md files are produced by `nx run <project>:di-graph-generate`. This renders whatever
# design.md files currently exist; run a build first if you want them freshly regenerated.
#
# The node program is written to a temp file (not piped via stdin) so the prompt can read YOUR
# selection from the terminal — `node <<HEREDOC` would consume stdin as the program itself.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

TMPJS="$(mktemp -t webpieces-design-viz.XXXXXX)"
trap 'rm -f "$TMPJS"' EXIT

cat > "$TMPJS" <<'NODE'
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), readline = require('readline');
const root = process.cwd();

function walk(d, acc) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', '.nx'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (e.name === 'design.md') acc.push(p);
    }
    return acc;
}

const projs = walk(root, []).sort().map(f => {
    const md = fs.readFileSync(f, 'utf-8');
    const m = md.match(/```mermaid\n([\s\S]*?)```/);
    const rel = path.relative(root, path.dirname(f));
    return { name: rel.split('/').pop(), rel, mermaid: m ? m[1].trim() : 'graph TD\n  none["(no graph)"]' };
});

if (projs.length === 0) {
    console.error('No design.md files found. Run a build (nx di-graph-generate) first.');
    process.exit(1);
}

console.log(`\n${projs.length} projects with a DI design graph:\n`);
projs.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(22)} ${p.rel}`));
console.log('');

function resolve(answer) {
    const a = answer.trim().toLowerCase();
    if (a === '' || a === 'q' || a === 'cancel' || a === 'none') return [];
    if (a === 'all' || a === '*') return projs.map((_, i) => i);
    const picked = new Set();
    for (const tok of a.split(/[\s,]+/).filter(Boolean)) {
        const n = Number(tok);
        if (Number.isInteger(n) && n >= 1 && n <= projs.length) { picked.add(n - 1); continue; }
        projs.forEach((p, i) => { if (p.name.toLowerCase().includes(tok) || p.rel.toLowerCase().includes(tok)) picked.add(i); });
    }
    return [...picked].sort((x, y) => x - y);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function pageFor(p) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} · DI design</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
:root{--bg:#0d1119;--panel:#151b26;--line:#26303d;--ink:#e6ebf2;--soft:#aab4c1;--faint:#78828f;--accent:#34c0b2}
@media(prefers-color-scheme:light){:root{--bg:#f4f6f8;--panel:#fff;--line:#dce1e7;--ink:#161b22;--soft:#47515e;--faint:#78828f;--accent:#0f8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:28px clamp(16px,4vw,48px) 80px}
header{margin:0 0 20px}h1{margin:0 0 4px;font-family:ui-monospace,Menlo,monospace;font-size:22px}
header code{font-size:12px;color:var(--faint);font-family:ui-monospace,Menlo,monospace}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
.mermaid{overflow-x:auto}
</style></head><body>
<header><h1>${esc(p.name)}</h1><code>${esc(p.rel)}/design.md</code></header>
<div class="card"><div class="mermaid">${esc(p.mermaid)}</div></div>
<script>mermaid.initialize({startOnLoad:true,theme:(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'default'),securityLevel:'loose'});</script>
</body></html>`;
}

function openTabs(indexes) {
    if (indexes.length === 0) { console.log('Nothing selected — cancelled.'); return; }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    for (const i of indexes) {
        const p = projs[i];
        const out = path.join(os.tmpdir(), `webpieces-design-${p.name}.html`);
        fs.writeFileSync(out, pageFor(p));
        try { cp.execSync(`${cmd} "${out}"`); console.log(`  ✅ ${p.name}`); }
        catch { console.log(`  ⚠️  ${p.name} — open manually: ${out}`); }
    }
    console.log(`\nOpened ${indexes.length} tab(s).`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Pick projects (numbers / name substrings / "all", blank = cancel): ', answer => {
    rl.close();
    openTabs(resolve(answer));
});
NODE

node "$TMPJS"
