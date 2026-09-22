import { CodeSample } from '../samples/CodeSamples';
import { Html } from './Html';
import { OperationInfo, SecuritySchemeInfo } from '../spec/ApiSpec';

/** The card heading above the code samples, and the control beside it. */
export const REQUEST_LABEL = 'REQUEST';
export const COLLAPSE_ALL_LABEL = 'COLLAPSE ALL';

/**
 * The sticky card column: what to authenticate with, and how to call it.
 *
 * `COLLAPSE ALL` lives here rather than in the body because it acts on the WHOLE body — a control
 * that collapses everything belongs beside the thing that stays put while the body scrolls.
 */
export class CardRenderer {
    private readonly html = new Html();

    /**
     * The authorization card: the credentials THIS operation requires, named by the header they are
     * sent in. Absent when the operation requires none — an empty card saying "no authorization"
     * reads, at a glance, exactly like a card whose contents failed to render.
     */
    authorization(operation: OperationInfo, schemes: readonly SecuritySchemeInfo[]): string {
        const required = schemes.filter((scheme: SecuritySchemeInfo): boolean =>
            operation.securityKeys.includes(scheme.key),
        );
        if (required.length === 0) {
            return '';
        }
        const rows = required
            .map((scheme: SecuritySchemeInfo): string => this.schemeRow(scheme))
            .join('');
        return this.card('AUTHORIZATION', '', `<div>${rows}</div>`);
    }

    /** The code samples, one tab per language, the first one visible with JS off. */
    samples(samples: readonly CodeSample[]): string {
        if (samples.length === 0) {
            return '';
        }
        const tabs = samples
            .map(
                (sample: CodeSample, index: number): string =>
                    `<button class="tab" type="button" data-language="${this.html.escape(sample.id)}" aria-selected="${index === 0 ? 'true' : 'false'}">${this.html.escape(sample.label)}</button>`,
            )
            .join('');
        const blocks = samples
            .map(
                (sample: CodeSample, index: number): string =>
                    `<pre class="sample" data-language="${this.html.escape(sample.id)}"${index === 0 ? '' : ' hidden'}><code>${this.html.escape(sample.source)}</code></pre>`,
            )
            .join('');
        return this.card(
            REQUEST_LABEL,
            `<button class="collapse-all" type="button">${COLLAPSE_ALL_LABEL}</button>`,
            `<div class="tabs">${tabs}</div><div class="card-body">${blocks}</div>`,
            false,
        );
    }

    /** A card holding one JSON example — the response body, or a schema page's sample. */
    example(title: string, json: string): string {
        if (json === '') {
            return '';
        }
        return this.card(title, '', `<pre><code>${this.html.escape(json)}</code></pre>`);
    }

    /** A plain card: a title and markup this package already rendered. */
    panel(title: string, body: string): string {
        return this.card(title, '', body);
    }

    private schemeRow(scheme: SecuritySchemeInfo): string {
        const where =
            scheme.headerName === ''
                ? this.html.escape(scheme.kind)
                : `<code>${this.html.escape(scheme.headerName)}</code>`;
        const prose =
            scheme.description === undefined
                ? ''
                : `<div class="field-doc">${this.html.escape(scheme.description)}</div>`;
        return `<div class="field"><div class="field-head"><span class="field-name">${this.html.escape(scheme.key)}</span><span class="field-type">${where}</span></div>${prose}</div>`;
    }

    private card(title: string, control: string, body: string, wrapBody = true): string {
        const inner = wrapBody ? `<div class="card-body">${body}</div>` : body;
        return `<section class="card"><div class="card-head"><span>${this.html.escape(title)}</span>${control}</div>${inner}</section>`;
    }
}
