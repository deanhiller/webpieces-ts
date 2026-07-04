/**
 * Responsibilities Extraction
 *
 * Every project must have a human-authored `responsibilities.md` at its root
 * describing the FULL responsibilities of the module (what belongs in it and
 * what does not). The first paragraph of that file is embedded into
 * architecture/dependencies.json as the project's `shortDescription` so AI
 * gets a summary just by reading the graph file.
 */

/**
 * Maximum length of the shortDescription embedded in dependencies.json.
 * The summary must stay small — full detail belongs in responsibilities.md.
 */
export const MAX_SHORT_DESCRIPTION_LENGTH = 300;

/**
 * Extract the shortDescription from responsibilities.md content:
 * the first non-empty paragraph after any leading markdown headings,
 * with newlines collapsed to single spaces.
 *
 * Returns '' when the file has no summary paragraph.
 */
export function extractShortDescription(markdown: string): string {
    const lines = markdown.split('\n');
    const paragraph: string[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (line.length === 0 || line.startsWith('#')) {
            // Blank line or heading ends the paragraph once started;
            // before that, keep scanning for the first paragraph.
            if (paragraph.length > 0) break;
            continue;
        }

        paragraph.push(line);
    }

    return paragraph.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validate an extracted shortDescription. Returns a problem description,
 * or null when the summary is valid.
 */
export function validateShortDescription(summary: string, sourceFile: string): string | null {
    if (summary.length === 0) {
        return (
            `${sourceFile} has no summary paragraph. ` +
            `Start the file with a heading, then ONE short paragraph ` +
            `(max ${MAX_SHORT_DESCRIPTION_LENGTH} chars) summarizing the module.`
        );
    }
    if (summary.length > MAX_SHORT_DESCRIPTION_LENGTH) {
        return (
            `${sourceFile} summary paragraph is ${summary.length} chars ` +
            `(max ${MAX_SHORT_DESCRIPTION_LENGTH}). Shorten the first paragraph; ` +
            `move detail into later sections of the file.`
        );
    }
    return null;
}
