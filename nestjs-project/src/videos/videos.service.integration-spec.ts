import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { VideosService } from './videos.service';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue-producer.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  let mockStorageService: jest.Mocked<StorageService>;
  let mockQueueProducer: jest.Mocked<VideoQueueProducer>;

  beforeAll(async () => {
    dataSource = createTestDataSource([
      User,
      Channel,
      RefreshToken,
      VerificationToken,
      Video,
    ]);
    await dataSource.initialize();

    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    mockStorageService = {
      getPresignedPutUrl: jest
        .fn()
        .mockResolvedValue('http://minio/presigned-url'),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-456'),
      getPresignedUploadPartUrl: jest
        .fn()
        .mockResolvedValue('http://minio/part-url'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageService>;

    mockQueueProducer = {
      addVideoProcessingJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoQueueProducer>;

    service = new VideosService(
      videoRepository,
      channelRepository,
      mockStorageService,
      mockQueueProducer,
      {
        endpoint: 'http://minio:9000',
        region: 'us-east-1',
        accessKey: 'minioadmin',
        secretKey: 'minioadmin',
        bucketVideos: 'streamtube-videos',
        bucketThumbnails: 'streamtube-thumbnails',
        forcePathStyle: true,
      },
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createConfirmedUserAndChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `uploader-${Date.now()}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Uploader Channel',
        nickname: `uploader_${Date.now()}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  it('persists a video draft and initiates direct-to-storage upload', async () => {
    const { user, channel } = await createConfirmedUserAndChannel();

    const result = await service.initUpload(user.id, {
      title: 'Integrated Video Upload',
      description: 'Testing video init upload integration',
      file_name: 'clip.mp4',
      file_size: 15 * 1024 * 1024, // 15MB
      content_type: 'video/mp4',
    });

    expect(result.video_id).toBeDefined();
    expect(result.upload_type).toBe('single');
    expect(result.upload_url).toBe('http://minio/presigned-url');

    const inDb = await videoRepository.findOneBy({ id: result.video_id });
    expect(inDb).toBeDefined();
    expect(inDb?.channel_id).toBe(channel.id);
    expect(inDb?.status).toBe(VideoStatus.DRAFT);
    expect(inDb?.slug).toBe(result.slug);
  });

  it('completes upload, updates status to PROCESSING, and publishes queue job', async () => {
    const { user, channel } = await createConfirmedUserAndChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Video To Complete',
        slug: 'slugcomplete1',
        storage_key: 'videos/key1.mp4',
        status: VideoStatus.DRAFT,
      }),
    );

    const completeResult = await service.completeUpload(video.id, user.id, {});

    expect(completeResult.video.status).toBe(VideoStatus.PROCESSING);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.status).toBe(VideoStatus.PROCESSING);

    expect(mockQueueProducer.addVideoProcessingJob).toHaveBeenCalledWith({
      videoId: video.id,
      storageKey: video.storage_key,
      channelId: channel.id,
    });
  });
});
