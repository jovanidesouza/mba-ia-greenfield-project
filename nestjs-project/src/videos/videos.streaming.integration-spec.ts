import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../app.module';
import { DomainExceptionFilter } from '../common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../common/filters/validation-exception.filter';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';

jest.setTimeout(30000);

interface HttpErrorBody {
  error: string;
}

function errorBody(res: { body: unknown }): HttpErrorBody {
  return res.body as HttpErrorBody;
}

describe('Video Streaming & Download (integration)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    await dataSource.synchronize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    storageService = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannelAndVideo(status: VideoStatus): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `stream-${Date.now()}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Stream Channel',
        nickname: `stream_${Date.now()}`,
        user_id: user.id,
      }),
    );

    const slug = `slug${Date.now()}`;
    const storageKey = `videos/${channel.id}/${slug}/sample.mp4`;

    // Upload sample video data (100 bytes) to MinIO
    const sampleBuffer = Buffer.from('A'.repeat(100));
    await storageService.uploadBuffer(
      'streamtube-videos',
      storageKey,
      sampleBuffer,
      'video/mp4',
    );

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Streaming Test Video',
        slug,
        storage_key: storageKey,
        status,
        duration_seconds: status === VideoStatus.READY ? 60 : null,
      }),
    );
  }

  it('GET /videos/:slug/stream returns 200 and full content when no Range header is sent', async () => {
    const video = await createChannelAndVideo(VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .buffer(true)
      .expect(200);

    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe('100');
    expect((res.body as Buffer).toString()).toBe('A'.repeat(100));
  });

  it('GET /videos/:slug/stream with Range header returns 206 Partial Content with correct byte chunk', async () => {
    const video = await createChannelAndVideo(VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .set('Range', 'bytes=0-19')
      .buffer(true)
      .expect(206);

    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-range']).toBe('bytes 0-19/100');
    expect(res.headers['content-length']).toBe('20');
    expect((res.body as Buffer).toString()).toBe('A'.repeat(20));
  });

  it('GET /videos/:slug/download returns 200 with Content-Disposition attachment', async () => {
    const video = await createChannelAndVideo(VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/download`)
      .buffer(true)
      .expect(200);

    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${video.slug}.mp4"`,
    );
    expect(res.headers['content-length']).toBe('100');
    expect((res.body as Buffer).toString()).toBe('A'.repeat(100));
  });

  it('returns 400 VIDEO_NOT_READY when streaming a video that is not in READY status', async () => {
    const video = await createChannelAndVideo(VideoStatus.PROCESSING);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .expect(400);

    expect(errorBody(res).error).toBe('VIDEO_NOT_READY');
  });

  it('returns 404 VIDEO_NOT_FOUND when streaming a non-existent slug', async () => {
    const res = await request(app.getHttpServer())
      .get('/videos/unknown-slug/stream')
      .expect(404);

    expect(errorBody(res).error).toBe('VIDEO_NOT_FOUND');
  });
});
