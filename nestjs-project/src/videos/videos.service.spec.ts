import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue-producer.service';
import storageConfig from '../config/storage.config';
import { VideoStatus } from './enums/video-status.enum';
import {
  ChannelNotFoundException,
  ForbiddenResourceException,
  InvalidUploadStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let channelRepository: jest.Mocked<Repository<Channel>>;
  let storageService: jest.Mocked<StorageService>;
  let videoQueueProducer: jest.Mocked<VideoQueueProducer>;

  beforeEach(async () => {
    videoRepository = {
      create: jest
        .fn()
        .mockImplementation((dto: Partial<Video>) => dto as Video),
      save: jest.fn().mockImplementation((entity: Partial<Video>) => {
        return Promise.resolve({
          ...entity,
          id: entity.id ?? 'video-uuid-1',
        } as Video);
      }),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
    } as unknown as jest.Mocked<Repository<Video>>;

    channelRepository = {
      findOneBy: jest.fn(),
    } as unknown as jest.Mocked<Repository<Channel>>;

    storageService = {
      getPresignedPutUrl: jest
        .fn()
        .mockResolvedValue('http://minio/upload-url'),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-123'),
      getPresignedUploadPartUrl: jest
        .fn()
        .mockResolvedValue('http://minio/part-url'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageService>;

    videoQueueProducer = {
      addVideoProcessingJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoQueueProducer>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository,
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: channelRepository,
        },
        {
          provide: StorageService,
          useValue: storageService,
        },
        {
          provide: VideoQueueProducer,
          useValue: videoQueueProducer,
        },
        {
          provide: storageConfig.KEY,
          useValue: {
            bucketVideos: 'streamtube-videos',
            bucketThumbnails: 'streamtube-thumbnails',
          },
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  describe('initUpload', () => {
    it('throws ChannelNotFoundException when user has no channel', async () => {
      channelRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.initUpload('user-1', {
          title: 'Test',
          file_name: 'test.mp4',
          file_size: 50 * 1024 * 1024,
          content_type: 'video/mp4',
        }),
      ).rejects.toThrow(ChannelNotFoundException);
    });

    it('creates single-part upload for files <= 100MB in DRAFT status', async () => {
      channelRepository.findOneBy.mockResolvedValue({
        id: 'channel-1',
        user_id: 'user-1',
      } as Channel);
      videoRepository.findOneBy.mockResolvedValue(null);

      const res = await service.initUpload('user-1', {
        title: 'Small Video',
        file_name: 'small.mp4',
        file_size: 50 * 1024 * 1024, // 50MB
        content_type: 'video/mp4',
      });

      expect(res.upload_type).toBe('single');
      expect(res.upload_url).toBe('http://minio/upload-url');
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          channel_id: 'channel-1',
          title: 'Small Video',
        }),
      );
    });

    it('creates multipart upload with part URLs for files > 100MB', async () => {
      channelRepository.findOneBy.mockResolvedValue({
        id: 'channel-1',
        user_id: 'user-1',
      } as Channel);
      videoRepository.findOneBy.mockResolvedValue(null);

      const res = await service.initUpload('user-1', {
        title: 'Large Video',
        file_name: 'large.mp4',
        file_size: 250 * 1024 * 1024, // 250MB => 25 parts
        content_type: 'video/mp4',
      });

      expect(res.upload_type).toBe('multipart');
      expect(res.upload_id).toBe('upload-id-123');
      expect(res.parts_urls?.length).toBe(25);
      expect(storageService.createMultipartUpload).toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException when video is not found', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('non-existent', 'user-1', {}),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws ForbiddenResourceException when user does not own the channel', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel: { user_id: 'other-user' },
      } as Video);

      await expect(
        service.completeUpload('video-1', 'user-1', {}),
      ).rejects.toThrow(ForbiddenResourceException);
    });

    it('throws InvalidUploadStateException when video status is not DRAFT/UPLOADING', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.READY,
        channel: { user_id: 'user-1' },
      } as Video);

      await expect(
        service.completeUpload('video-1', 'user-1', {}),
      ).rejects.toThrow(InvalidUploadStateException);
    });

    it('updates status to PROCESSING and queues BullMQ job', async () => {
      const video = {
        id: 'video-1',
        status: VideoStatus.DRAFT,
        storage_key: 'videos/c1/slug/v.mp4',
        channel_id: 'c1',
        channel: { user_id: 'user-1' },
      } as Video;
      videoRepository.findOne.mockResolvedValue(video);

      const res = await service.completeUpload('video-1', 'user-1', {});

      expect(res.video.status).toBe(VideoStatus.PROCESSING);
      expect(videoQueueProducer.addVideoProcessingJob).toHaveBeenCalledWith({
        videoId: 'video-1',
        storageKey: 'videos/c1/slug/v.mp4',
        channelId: 'c1',
      });
    });
  });

  describe('findBySlug', () => {
    it('throws VideoNotFoundException when slug does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.findBySlug('invalid-slug')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns the video entity when slug exists', async () => {
      const video = { id: 'v1', slug: 'valid-slug' } as Video;
      videoRepository.findOne.mockResolvedValue(video);

      const found = await service.findBySlug('valid-slug');
      expect(found).toBe(video);
    });
  });
});
