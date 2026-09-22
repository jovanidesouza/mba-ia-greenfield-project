import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue-producer.service';
import { generateVideoSlug } from './utils/video-slug.util';
import type { Readable } from 'stream';
import type { InitUploadDto } from './dto/init-upload.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  ChannelNotFoundException,
  ForbiddenResourceException,
  InvalidUploadStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';

// 100MB threshold for multipart vs single-part upload
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;
// 10MB default part size for multipart
const DEFAULT_PART_SIZE = 10 * 1024 * 1024;

export interface InitUploadResult {
  video_id: string;
  slug: string;
  upload_type: 'single' | 'multipart';
  upload_url?: string;
  upload_id?: string;
  parts_urls?: { part_number: number; url: string }[];
  key: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly videoQueueProducer: VideoQueueProducer,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    const channel = await this.channelRepository.findOneBy({ user_id: userId });
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const slug = await this.generateUniqueSlug();
    const sanitizedFileName = dto.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `videos/${channel.id}/${slug}/${sanitizedFileName}`;

    const video = this.videoRepository.create({
      channel_id: channel.id,
      title: dto.title,
      description: dto.description ?? null,
      slug,
      storage_key: storageKey,
      status: VideoStatus.DRAFT,
    });

    const savedVideo = await this.videoRepository.save(video);
    const bucket = this.storageCfg.bucketVideos;

    if (dto.file_size <= MULTIPART_THRESHOLD) {
      const uploadUrl = await this.storageService.getPresignedPutUrl(
        bucket,
        storageKey,
        dto.content_type,
      );
      return {
        video_id: savedVideo.id,
        slug: savedVideo.slug,
        upload_type: 'single',
        upload_url: uploadUrl,
        key: storageKey,
      };
    } else {
      const uploadId = await this.storageService.createMultipartUpload(
        bucket,
        storageKey,
        dto.content_type,
      );

      const partCount = Math.ceil(dto.file_size / DEFAULT_PART_SIZE);
      const partsUrls: { part_number: number; url: string }[] = [];

      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        const url = await this.storageService.getPresignedUploadPartUrl(
          bucket,
          storageKey,
          uploadId,
          partNumber,
        );
        partsUrls.push({ part_number: partNumber, url });
      }

      return {
        video_id: savedVideo.id,
        slug: savedVideo.slug,
        upload_type: 'multipart',
        upload_id: uploadId,
        parts_urls: partsUrls,
        key: storageKey,
      };
    }
  }

  async completeUpload(
    videoId: string,
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<{ message: string; video: Video }> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new ForbiddenResourceException();
    }

    if (
      video.status !== VideoStatus.DRAFT &&
      video.status !== VideoStatus.UPLOADING
    ) {
      throw new InvalidUploadStateException();
    }

    // Complete multipart upload if parts were provided
    if (dto.parts && dto.parts.length > 0) {
      // Find uploadId or finalize through storageService
      // Note: for multipart, the client submits parts with ETag and PartNumber
    }

    video.status = VideoStatus.PROCESSING;
    const updatedVideo = await this.videoRepository.save(video);

    await this.videoQueueProducer.addVideoProcessingJob({
      videoId: updatedVideo.id,
      storageKey: updatedVideo.storage_key,
      channelId: updatedVideo.channel_id,
    });

    return {
      message: 'Upload completed, processing queued',
      video: updatedVideo,
    };
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async getStream(
    slug: string,
    rangeHeader?: string,
  ): Promise<{
    stream: Readable;
    contentLength?: number;
    contentRange?: string;
    contentType?: string;
    acceptRanges?: string;
  }> {
    const video = await this.findBySlug(slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const bucket = this.storageCfg.bucketVideos;
    return this.storageService.getObjectStream(
      bucket,
      video.storage_key,
      rangeHeader,
    );
  }

  async getDownloadStream(slug: string): Promise<{
    stream: Readable;
    filename: string;
    contentLength?: number;
    contentType?: string;
  }> {
    const video = await this.findBySlug(slug);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const bucket = this.storageCfg.bucketVideos;
    const streamInfo = await this.storageService.getObjectStream(
      bucket,
      video.storage_key,
    );

    const ext = video.storage_key.split('.').pop() || 'mp4';
    const filename = `${video.slug}.${ext}`;

    return {
      stream: streamInfo.stream,
      filename,
      contentLength: streamInfo.contentLength,
      contentType: streamInfo.contentType || 'video/mp4',
    };
  }

  private async generateUniqueSlug(maxRetries = 5): Promise<string> {
    for (let i = 0; i < maxRetries; i++) {
      const candidate = generateVideoSlug(10);
      const existing = await this.videoRepository.findOneBy({
        slug: candidate,
      });
      if (!existing) {
        return candidate;
      }
    }
    return generateVideoSlug(16);
  }
}
