#!/bin/sh
# Open the DI design graph (the generated design.md constructor-injection DAGs) for the
# CONTROLLERS you pick — the per-controller companion to `arch:visualize` (which shows one
# combined module graph). Each project's design.md now holds one diagram PER controller (or
# per library top-of-DAG root); this prompts you to choose which controllers to render and
# opens EACH chosen controller as its own separate diagram in a single browser tab.
#
# Usage:  pnpm design:visualize
#   At the prompt enter: space/comma-separated numbers (e.g. "1 4 7"), name substrings
#   (e.g. "save server2"), "all", or blank to cancel. Non-interactive: `echo all | pnpm design:visualize`.
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

// Each design.md holds one `## <Root> — <kind>, Level 0…N` section followed by a ```mermaid block.
// Flatten every project's sections into a single pick list of controllers/roots.
const entries = [];
for (const f of walk(root, []).sort()) {
    const md = fs.readFileSync(f, 'utf-8');
    const project = path.relative(root, path.dirname(f)).split('/').pop();
    const rel = path.relative(root, f);
    const re = /^##\s+(.+?)\n[\s\S]*?```mermaid\n([\s\S]*?)```/gm;
    let m;
    while ((m = re.exec(md)) !== null) {
        const heading = m[1].trim();
        const name = heading.split(/\s+[—-]\s+/)[0].trim();
        entries.push({ project, rel, name, heading, mermaid: m[2].trim() });
    }
}

if (entries.length === 0) {
    console.error('No controller design diagrams found. Run a build (nx di-graph-generate) first.');
    process.exit(1);
}

console.log(`\n${entries.length} controller/root design diagram(s):\n`);
entries.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${(e.project + ' / ' + e.name).padEnd(40)} ${e.rel}`));
console.log('');

function resolve(answer) {
    const a = answer.trim().toLowerCase();
    if (a === '' || a === 'q' || a === 'cancel' || a === 'none') return [];
    if (a === 'all' || a === '*') return entries.map((_, i) => i);
    const picked = new Set();
    for (const tok of a.split(/[\s,]+/).filter(Boolean)) {
        const n = Number(tok);
        if (Number.isInteger(n) && n >= 1 && n <= entries.length) { picked.add(n - 1); continue; }
        entries.forEach((e, i) => {
            if (e.name.toLowerCase().includes(tok) || e.project.toLowerCase().includes(tok) || e.rel.toLowerCase().includes(tok)) picked.add(i);
        });
    }
    return [...picked].sort((x, y) => x - y);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function cardFor(e) {
    return `<section class="card">
  <h2>${esc(e.name)}</h2>
  <code>${esc(e.project)} · ${esc(e.heading)}</code>
  <div class="mermaid">${esc(e.mermaid)}</div>
</section>`;
}
function pageFor(indexes) {
    const cards = indexes.map((i) => cardFor(entries[i])).join('\n');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DI design · ${indexes.length} diagram(s)</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
:root{--bg:#0d1119;--panel:#151b26;--line:#26303d;--ink:#e6ebf2;--soft:#aab4c1;--faint:#78828f;--accent:#34c0b2}
@media(prefers-color-scheme:light){:root{--bg:#f4f6f8;--panel:#fff;--line:#dce1e7;--ink:#161b22;--soft:#47515e;--faint:#78828f;--accent:#0f8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:28px clamp(16px,4vw,48px) 80px}
header{margin:0 0 20px}h1{margin:0 0 4px;font-family:ui-monospace,Menlo,monospace;font-size:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 20px}
.card h2{margin:0 0 4px;font-family:ui-monospace,Menlo,monospace;font-size:18px}
.card code{display:block;font-size:12px;color:var(--faint);font-family:ui-monospace,Menlo,monospace;margin:0 0 14px}
.mermaid{overflow-x:auto}
</style></head><body>
<header><h1>DI design — ${indexes.length} diagram(s)</h1></header>
${cards}
<script>mermaid.initialize({startOnLoad:true,theme:(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'default'),securityLevel:'loose'});</script>
</body></html>`;
}

function openPage(indexes) {
    if (indexes.length === 0) { console.log('Nothing selected — cancelled.'); return; }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    const out = path.join(os.tmpdir(), `webpieces-design-${indexes.length}-diagrams.html`);
    fs.writeFileSync(out, pageFor(indexes));
    for (const i of indexes) console.log(`  ✅ ${entries[i].project} / ${entries[i].name}`);
    try { cp.execSync(`${cmd} "${out}"`); console.log(`\nOpened ${indexes.length} diagram(s) in one tab.`); }
    catch { console.log(`\n⚠️  Could not open a browser — open manually: ${out}`); }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Pick controllers (numbers / name substrings / "all", blank = cancel): ', answer => {
    rl.close();
    openPage(resolve(answer));
});
NODE

node "$TMPJS"
