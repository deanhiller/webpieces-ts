/** Pure renderer for the AI-authored review.json shape printed by the PR gate. */
export class ReviewJsonSchemaRenderer {
    render(filePath: string, mainAgentInstructions = ''): string {
        const instructions = mainAgentInstructions === '' ? ''
            : `,\n  "main_agent_instructions": ${JSON.stringify(mainAgentInstructions)}\n`;
        return (
            `Write your PR review to:\n  ${filePath}\n\n` +
            'with this exact JSON shape (riskEmoji optional — derived from riskLevel):\n\n' +
            '{\n' +
            '  "title": "concise PR title describing the change (imperative, no branch names)",\n' +
            '  "agent": "claude | codex | unknown",\n' +
            '  "model": "opus | sonnet | actual readable model name | unknown",\n' +
            '  "riskScore": 0,                       // integer 0–100 (higher = riskier)\n' +
            '  "riskLevel": "green | yellow | red",\n' +
            '  "summary": "5–10 sentence review summary",\n' +
            '  "violations": ["pattern/architecture violations you found (empty array if none)"],\n' +
            '  "risks": ["notable risks (empty array if none)"],\n' +
            `  "filesToReview": ["paths a human should look at (empty array if none)"]${instructions}\n` +
            '}'
        );
    }
}
