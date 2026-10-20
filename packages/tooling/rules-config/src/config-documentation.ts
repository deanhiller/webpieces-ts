export const CONFIG_DOCUMENTATION_KEY = 'webpiecesConfigJsonDocumentation';
export const CONFIG_DOCUMENTATION_PATH = '.webpieces/instruct-ai/webpieces.config-policy.md';

/** Inline prose belongs in tracked Markdown, including notes nested inside gates or checklists. */
export class ConfigDocumentation {
    // webpieces-disable no-any-unknown -- traversing unvalidated JSON to reject retired documentation keys
    inlineErrors(value: unknown, label: string): string[] {
        if (Array.isArray(value))
            return value.flatMap((entry, index) => this.inlineErrors(entry, `${label}[${index}]`));
        if (value === null || typeof value !== 'object') return [];
        return Object.entries(value).flatMap((entry) =>
            entry[0].endsWith('Why')
                ? [`${label} "${entry[0]}" is a retired inline documentation key. Remove it from JSON; ` +
                   `keep repository-specific rationale in tracked Markdown. ` +
                   `Config instructions: ${CONFIG_DOCUMENTATION_PATH}.`]
                : this.inlineErrors(entry[1], `${label}.${entry[0]}`),
        );
    }
}
