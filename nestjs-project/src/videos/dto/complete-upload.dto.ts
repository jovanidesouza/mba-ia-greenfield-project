import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class MultipartPartDto {
  @IsInt()
  @IsNotEmpty()
  PartNumber: number;

  @IsString()
  @IsNotEmpty()
  ETag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MultipartPartDto)
  parts?: MultipartPartDto[];
}
