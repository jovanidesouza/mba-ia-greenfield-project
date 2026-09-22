import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { VideosService } from './videos.service';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('init')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initialize video upload',
    description:
      'Creates a new video draft record with a unique slug and issues direct S3/MinIO upload URLs (single PUT or multipart upload parts).',
  })
  @ApiResponse({
    status: 201,
    description: 'Video draft created and presigned upload URL(s) issued.',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or file size exceeds maximum 10GB.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized — requires valid JWT access token.',
  })
  @ApiResponse({
    status: 404,
    description: 'Channel not found for current user.',
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ) {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete video upload',
    description:
      'Validates video ownership and state, transitions status to PROCESSING, and enqueues a background transcode/thumbnail job.',
  })
  @ApiParam({ name: 'id', description: 'UUID of the video record' })
  @ApiResponse({
    status: 200,
    description: 'Upload confirmed and background processing job queued.',
  })
  @ApiResponse({
    status: 400,
    description: 'Video is not in DRAFT/UPLOADING state.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized.',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — user does not own this channel.',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found.',
  })
  async completeUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(id, user.sub, dto);
  }

  @Get(':slug/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream video content',
    description:
      'Streams video directly from storage. Supports HTTP Range header for seeking with 206 Partial Content response.',
  })
  @ApiParam({ name: 'slug', description: 'Unique public slug of the video' })
  @ApiHeader({
    name: 'Range',
    required: false,
    description: 'HTTP Byte range header (e.g. bytes=0-1048576)',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video stream.',
  })
  @ApiResponse({
    status: 206,
    description: 'Partial content byte stream according to requested Range.',
  })
  @ApiResponse({
    status: 400,
    description: 'Video is not in READY state.',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found.',
  })
  async getStream(
    @Param('slug') slug: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const streamInfo = await this.videosService.getStream(slug, range);

    res.setHeader('Accept-Ranges', streamInfo.acceptRanges || 'bytes');
    if (streamInfo.contentType) {
      res.setHeader('Content-Type', streamInfo.contentType);
    }
    if (streamInfo.contentLength !== undefined) {
      res.setHeader('Content-Length', streamInfo.contentLength);
    }

    if (range && streamInfo.contentRange) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', streamInfo.contentRange);
    } else {
      res.status(HttpStatus.OK);
    }

    streamInfo.stream.pipe(res);
  }

  @Get(':slug/download')
  @Public()
  @ApiOperation({
    summary: 'Download original video file',
    description:
      'Provides direct file download of the video with Content-Disposition attachment header.',
  })
  @ApiParam({ name: 'slug', description: 'Unique public slug of the video' })
  @ApiResponse({
    status: 200,
    description: 'Binary video file stream.',
  })
  @ApiResponse({
    status: 400,
    description: 'Video is not in READY state.',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found.',
  })
  async getDownload(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const downloadInfo = await this.videosService.getDownloadStream(slug);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadInfo.filename}"`,
    );
    if (downloadInfo.contentType) {
      res.setHeader('Content-Type', downloadInfo.contentType);
    }
    if (downloadInfo.contentLength !== undefined) {
      res.setHeader('Content-Length', downloadInfo.contentLength);
    }

    res.status(HttpStatus.OK);
    downloadInfo.stream.pipe(res);
  }

  @Get(':slug')
  @Public()
  @ApiOperation({
    summary: 'Get video details by slug',
    description: 'Returns public video details and status by its unique slug.',
  })
  @ApiParam({ name: 'slug', description: 'Unique public slug of the video' })
  @ApiResponse({
    status: 200,
    description: 'Video metadata and status.',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found.',
  })
  async getBySlug(@Param('slug') slug: string) {
    return this.videosService.findBySlug(slug);
  }
}
