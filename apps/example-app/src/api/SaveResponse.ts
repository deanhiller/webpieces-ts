/**
 * Match result DTO.
 * Similar to Java TheMatch class.
 */
export class TheMatch {
    title: string = '';
    description: string = '';
    score: number = 0;
}

/**
 * Save response DTO.
 * Similar to Java SaveResponse class.
 */
export class SaveResponse {
    searchTime: number = 0;
    success: boolean = false;
    matches: TheMatch[] = [];
}
