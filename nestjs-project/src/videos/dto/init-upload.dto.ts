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
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsNotEmpty()
  file_name: string;

  @IsInt()
  @IsPositive()
  @Min(1)
  @Max(10737418240, { message: 'File size exceeds maximum allowed 10GB' }) // 10GB limit
  file_size: number;

  @IsString()
  @IsNotEmpty()
  content_type: string;
}
