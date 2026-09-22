import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({
    description: 'Part number in the multipart upload sequence',
    example: 1,
  })
  @IsInt()
  @IsNotEmpty()
  PartNumber: number;

  @ApiProperty({
    description: 'ETag returned by S3 upon uploading the part',
    example: '"d41d8cd98f00b204e9800998ecf8427e"',
  })
  @IsString()
  @IsNotEmpty()
  ETag: string;
}

export class CompleteUploadDto {
  @ApiPropertyOptional({
    description:
      'Array of uploaded parts with their ETags for multipart uploads',
    type: [MultipartPartDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MultipartPartDto)
  parts?: MultipartPartDto[];
}
