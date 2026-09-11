/** Reviewer-supplied identity is plain text, never Markdown or an HTML comment marker. */
export class ReviewIdentityRenderer {
    render(agent: string, model: string, label = 'Agent'): string {
        return `**${label}:** ${this.text(agent)} · **Model:** ${this.text(model)} (self-reported)`;
    }

    /** Author harness is observed by the gate; only the model comes from the author's review.json. */
    renderAuthor(agent: string, model: string, markdown = true): string {
        const label = markdown ? '**Author agent:**' : 'Author agent:';
        const modelLabel = markdown ? '**Model:**' : 'Model:';
        return `${label} ${this.text(agent)} (detected) · ${modelLabel} ${this.text(model)} (self-reported)`;
    }

    private text(value: string): string {
        return value.replace(/\s+/g, ' ').replace(/[&<>\\`*_{}\[\]()#!|~]/g,
            (character: string): string => `&#${character.charCodeAt(0)};`);
    }
}
