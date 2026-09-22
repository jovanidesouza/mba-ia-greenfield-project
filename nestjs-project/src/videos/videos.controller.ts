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
import type { Response } from 'express';
import { VideosService } from './videos.service';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('init')
  @HttpCode(HttpStatus.CREATED)
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ) {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(id, user.sub, dto);
  }

  @Get(':slug/stream')
  @Public()
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
  async getBySlug(@Param('slug') slug: string) {
    return this.videosService.findBySlug(slug);
  }
}
