import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class InitUploadDto {
  @ApiProperty({
    description: 'Title of the video',
    maxLength: 255,
    example: 'My First Video',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiPropertyOptional({
    description: 'Optional description of the video',
    example: 'This is a description of my first video.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Original name of the video file',
    example: 'gameplay.mp4',
  })
  @IsString()
  @IsNotEmpty()
  file_name: string;

  @ApiProperty({
    description:
      'Size of the file in bytes (up to 10GB = 10,737,418,240 bytes)',
    minimum: 1,
    maximum: 10737418240,
    example: 52428800,
  })
  @IsInt()
  @IsPositive()
  @Min(1)
  @Max(10737418240, { message: 'File size exceeds maximum allowed 10GB' }) // 10GB limit
  file_size: number;

  @ApiProperty({
    description: 'MIME content type of the video file',
    example: 'video/mp4',
  })
  @IsString()
  @IsNotEmpty()
  content_type: string;
}
