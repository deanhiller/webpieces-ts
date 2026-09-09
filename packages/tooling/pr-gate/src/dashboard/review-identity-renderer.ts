/** Reviewer-supplied identity is plain text, never Markdown or an HTML comment marker. */
export class ReviewIdentityRenderer {
    render(agent: string, model: string, label = 'Agent'): string {
        return `**${label}:** ${this.text(agent)} · **Model:** ${this.text(model)} (self-reported)`;
    }

    private text(value: string): string {
        return value.replace(/\s+/g, ' ').replace(/[&<>\\`*_{}\[\]()#!|~]/g,
            (character: string): string => `&#${character.charCodeAt(0)};`);
    }
}
