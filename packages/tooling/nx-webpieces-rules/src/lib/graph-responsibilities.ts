/**
 * Responsibilities Section
 *
 * Renders every module's full `responsibilities.md` as a collapsible card below
 * the dependency graph in architecture/dependencies.html. Cards are ordered by
 * dependency level HIGH → LOW (top-level apps first, deepest libs last) so a
 * reader scrolls from the runnable servers/clients down into the libraries.
 *
 * Each card carries `data-node="<shortName>"` matching the graph box's title, so
 * the page script can filter the list to just the locked box's chain (see
 * graph-visualizer.client.js). The summary paragraph is the `shortDescription`
 * already on each graph entry; the expanded body is the rendered markdown file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EnhancedGraph, GraphEntry } from './graph-sorter';
import { GraphNames } from './graph-names';

/**
 * Mutable cursor state threaded through the markdown line renderer: whether we
 * are currently inside an open `<ul>` (so the next blank line / heading / non-
 * bullet closes it).
 */
class MarkdownListState {
    inList = false;
}

export class ResponsibilitiesRenderer {
    private readonly names = new GraphNames();

    /**
     * Build the responsibilities section HTML: one collapsible card per module,
     * sorted by level descending (tie-break by name ascending). Returned as a
     * <section> that GraphVisualizer injects below the graph.
     */
    generateSection(graph: EnhancedGraph, workspaceRoot: string): string {
        const projects = Object.keys(graph);
        projects.sort((a: string, b: string): number => {
            const levelDiff = graph[b].level - graph[a].level;
            if (levelDiff !== 0) return levelDiff;
            return a.localeCompare(b);
        });

        const cards: string[] = [];
        for (const project of projects) {
            // Hidden projects (drawOnGraph:false) are omitted from the graph, so
            // they get no responsibilities card either.
            if (graph[project].drawOnGraph === false) continue;
            cards.push(this.renderCard(project, graph[project], workspaceRoot));
        }

        return (
            `<section id="wp-responsibilities">` +
            `<h2>Responsibilities (level high → low)</h2>` +
            `<p class="hint">Lock a box above to narrow this list to just that box's dependency chain.</p>` +
            cards.join('\n') +
            `</section>`
        );
    }

    private renderCard(project: string, entry: GraphEntry, workspaceRoot: string): string {
        const shortName = this.names.getShortName(project);
        const summary = entry.shortDescription ?? '';
        const summaryHtml = summary ? ` — ${this.escapeHtml(summary)}` : '';
        const body = this.readBody(entry, workspaceRoot);
        return (
            `<details class="wp-resp-card" data-node="${this.escapeHtml(shortName)}">` +
            `<summary><span class="wp-resp-level">L${entry.level}</span> ` +
            `<strong>${this.escapeHtml(shortName)}</strong>${summaryHtml}</summary>` +
            `<div class="wp-resp-body">${body}</div>` +
            `</details>`
        );
    }

    /**
     * Read a module's responsibilities.md body. Generation already guarantees the
     * file exists (metadata validation throws otherwise); a fallback line guards
     * the edge case where the graph JSON is stale relative to disk.
     */
    private readBody(entry: GraphEntry, workspaceRoot: string): string {
        const file = entry.responsibilitiesFile;
        if (!file) return '<p><em>No responsibilities.md recorded for this module.</em></p>';
        const absolutePath = path.join(workspaceRoot, file);
        if (!fs.existsSync(absolutePath)) {
            return `<p><em>Missing ${this.escapeHtml(file)}.</em></p>`;
        }
        return this.renderMarkdown(fs.readFileSync(absolutePath, 'utf-8'));
    }

    /**
     * Minimal markdown → HTML for a responsibilities.md body. Handles ATX headings
     * (`#`..`######`), `-`/`*` bullet lists, and blank-line-separated paragraphs.
     * Everything is HTML-escaped first; only a small inline set is re-marked. This
     * is deliberately tiny — responsibilities.md files are short and structured,
     * and the repo has no markdown dependency.
     */
    private renderMarkdown(markdown: string): string {
        const out: string[] = [];
        const state = new MarkdownListState();
        for (const rawLine of markdown.split('\n')) {
            this.renderLine(rawLine.trim(), out, state);
        }
        if (state.inList) out.push('</ul>');
        return out.join('\n');
    }

    private renderLine(line: string, out: string[], state: MarkdownListState): void {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        if (line.length === 0) {
            if (state.inList) { out.push('</ul>'); state.inList = false; }
            return;
        }
        if (heading) {
            if (state.inList) { out.push('</ul>'); state.inList = false; }
            const level = Math.min(heading[1].length + 3, 6); // # → h4, ## → h5, deeper → h6
            out.push(`<h${level}>${this.renderInline(this.escapeHtml(heading[2]))}</h${level}>`);
            return;
        }
        if (bullet) {
            if (!state.inList) { out.push('<ul>'); state.inList = true; }
            out.push(`<li>${this.renderInline(this.escapeHtml(bullet[1]))}</li>`);
            return;
        }
        if (state.inList) { out.push('</ul>'); state.inList = false; }
        out.push(`<p>${this.renderInline(this.escapeHtml(line))}</p>`);
    }

    /**
     * Render inline markdown spans within an already HTML-escaped line: `code` →
     * <code>, **bold** → <strong>, *italic* → <em>.
     */
    private renderInline(escaped: string): string {
        return escaped
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    }

    /**
     * Escape a string for safe embedding in HTML text/attributes.
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
