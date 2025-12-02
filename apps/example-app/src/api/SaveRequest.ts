import { IsString, IsNotEmpty, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Search metadata DTO.
 * Similar to Java SearchMeta class.
 */
export class SearchMeta {
    @IsString()
    @IsOptional()
    source?: string;

    @IsString()
    @IsOptional()
    filter?: string;
}

/**
 * Save request DTO.
 * Similar to Java SaveRequest class.
 */
export class SaveRequest {
    @IsString()
    @IsNotEmpty()
    query: string = '';

    @ValidateNested()
    @Type(() => SearchMeta)
    @IsOptional()
    meta?: SearchMeta;
}
