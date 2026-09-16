/** HTTP adapter failure for a status outside 100-599 (so not an ApiCodedError) not claimed by an app translator. */
export class UnexpectedApiResponseError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string,
    ) {
        super(message);
        this.name = 'UnexpectedApiResponseError';
    }
}
