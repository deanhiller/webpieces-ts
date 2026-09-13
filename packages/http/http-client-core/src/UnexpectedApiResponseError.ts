/** HTTP adapter failure for an unrecognized status not claimed by an app translator. */
export class UnexpectedApiResponseError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string,
    ) {
        super(message);
        this.name = 'UnexpectedApiResponseError';
    }
}
