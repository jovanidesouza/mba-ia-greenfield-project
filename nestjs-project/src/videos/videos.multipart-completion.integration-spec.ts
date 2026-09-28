import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { VideosService } from './videos.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue-producer.service';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

// Files above this size trigger the multipart branch in VideosService.initUpload
const MULTIPART_FILE_SIZE = 101 * 1024 * 1024;
// S3/MinIO requires every part except the last to be at least 5MB
const PART_ONE_SIZE = 5 * 1024 * 1024;

describe('VideosService multipart completion (integration, real MinIO)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let mockQueueProducer: jest.Mocked<VideoQueueProducer>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const storageService = module.get(StorageService);
    await storageService.onModuleInit();

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

    mockQueueProducer = {
      addVideoProcessingJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideoQueueProducer>;

    service = new VideosService(
      videoRepository,
      channelRepository,
      storageService,
      mockQueueProducer,
      module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    mockQueueProducer.addVideoProcessingJob.mockClear();
  });

  async function createConfirmedUserAndChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `multipart-${Date.now()}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Multipart Channel',
        nickname: `multipart_${Date.now()}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  it('persists the S3 upload_id returned by initUpload for a multipart video', async () => {
    const { user } = await createConfirmedUserAndChannel();

    const result = await service.initUpload(user.id, {
      title: 'Large Video',
      file_name: 'large.mp4',
      file_size: MULTIPART_FILE_SIZE,
      content_type: 'video/mp4',
    });

    expect(result.upload_type).toBe('multipart');
    expect(result.upload_id).toBeDefined();

    const stored = await videoRepository.findOneBy({ id: result.video_id });
    expect(stored?.upload_id).toBe(result.upload_id);
  });

  it('rejects completion with a fabricated ETag instead of silently accepting it', async () => {
    const { user } = await createConfirmedUserAndChannel();

    const initResult = await service.initUpload(user.id, {
      title: 'Tampered Video',
      file_name: 'tampered.mp4',
      file_size: MULTIPART_FILE_SIZE,
      content_type: 'video/mp4',
    });

    const partOneUrl = initResult.parts_urls![0].url;
    const uploadRes = await fetch(partOneUrl, {
      method: 'PUT',
      body: Buffer.alloc(PART_ONE_SIZE, 'a'),
    });
    expect(uploadRes.status).toBe(200);

    await expect(
      service.completeUpload(initResult.video_id, user.id, {
        parts: [{ PartNumber: 1, ETag: '"00000000000000000000000000000000"' }],
      }),
    ).rejects.toThrow();

    const stillProcessing = await videoRepository.findOneBy({
      id: initResult.video_id,
    });
    expect(stillProcessing?.status).not.toBe(VideoStatus.PROCESSING);
    expect(mockQueueProducer.addVideoProcessingJob).not.toHaveBeenCalled();
  });

  it('finalizes the multipart upload in MinIO and enqueues processing when ETags are genuine', async () => {
    const { user } = await createConfirmedUserAndChannel();

    const initResult = await service.initUpload(user.id, {
      title: 'Genuine Video',
      file_name: 'genuine.mp4',
      file_size: MULTIPART_FILE_SIZE,
      content_type: 'video/mp4',
    });

    const partOneUrl = initResult.parts_urls![0].url;
    const uploadRes = await fetch(partOneUrl, {
      method: 'PUT',
      body: Buffer.alloc(PART_ONE_SIZE, 'a'),
    });
    const etag = uploadRes.headers.get('etag');
    expect(etag).toBeDefined();

    const completeResult = await service.completeUpload(
      initResult.video_id,
      user.id,
      { parts: [{ PartNumber: 1, ETag: etag! }] },
    );

    expect(completeResult.video.status).toBe(VideoStatus.PROCESSING);
    expect(mockQueueProducer.addVideoProcessingJob).toHaveBeenCalledWith({
      videoId: initResult.video_id,
      storageKey: completeResult.video.storage_key,
      channelId: completeResult.video.channel_id,
    });
  });
});
