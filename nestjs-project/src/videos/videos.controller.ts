import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
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

  @Get(':slug')
  @Public()
  async getBySlug(@Param('slug') slug: string) {
    return this.videosService.findBySlug(slug);
  }
}
