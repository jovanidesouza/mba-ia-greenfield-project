import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { WorkerModule } from './worker.module';
import { VideoProcessorWorker } from './video-processor.worker';
import { Video } from '../videos/entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { VideoStatus } from '../videos/enums/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { JOB_PROCESS_VIDEO } from '../queue/queue.constants';
import type { Job } from 'bullmq';
import type { ProcessVideoJobPayload } from '../queue/interfaces/process-video-job.interface';
import { cleanAllTables } from '../test/create-test-data-source';

jest.setTimeout(30000);

describe('VideoProcessorWorker (integration)', () => {
  let module: TestingModule;
  let worker: VideoProcessorWorker;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let storageService: StorageService;
  let testVideoBuffer: Buffer;

  beforeAll(async () => {
    // Generate a small, valid 2-second H.264 MP4 file via ffmpeg for real inspection
    const tmpVideo = path.join(os.tmpdir(), `test-src-${Date.now()}.mp4`);
    cp.execSync(
      `ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=1:duration=2 -t 2 -c:v libx264 -pix_fmt yuv420p "${tmpVideo}"`,
      { stdio: 'ignore' },
    );
    testVideoBuffer = fs.readFileSync(tmpVideo);
    fs.unlinkSync(tmpVideo);

    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    worker = module.get(VideoProcessorWorker);
    dataSource = module.get(DataSource);
    await dataSource.synchronize();

    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    storageService = module.get(StorageService);
    await storageService.onModuleInit();
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('processes a real MP4 video: extracts duration, generates thumbnail, and sets status to READY', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: `worker-test-${Date.now()}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );

    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Worker Channel',
        nickname: `worker_${Date.now()}`,
        user_id: user.id,
      }),
    );

    const slug = `slug${Date.now()}`;
    const storageKey = `videos/${channel.id}/${slug}/sample.mp4`;

    // Upload the real video file to MinIO
    await storageService.uploadBuffer(
      'streamtube-videos',
      storageKey,
      testVideoBuffer,
      'video/mp4',
    );

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Real Video Test',
        slug,
        storage_key: storageKey,
        status: VideoStatus.PROCESSING,
      }),
    );

    const job = {
      id: 'job-real-1',
      name: JOB_PROCESS_VIDEO,
      data: {
        videoId: video.id,
        storageKey: video.storage_key,
        channelId: channel.id,
      },
    } as Job<ProcessVideoJobPayload>;

    await worker.process(job);

    // Verify video status in database updated to READY
    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated).toBeDefined();
    expect(updated?.status).toBe(VideoStatus.READY);
    expect(updated?.duration_seconds).toBe(2);
    expect(updated?.thumbnail_url).toBe(
      `thumbnails/${channel.id}/${slug}/thumb.jpg`,
    );
    expect(updated?.error_message).toBeNull();

    // Verify thumbnail exists in MinIO storage
    const thumbStream = await storageService.getObjectStream(
      'streamtube-thumbnails',
      updated!.thumbnail_url!,
    );
    expect(thumbStream.contentType).toBe('image/jpeg');
    expect(thumbStream.contentLength).toBeGreaterThan(0);
  });
});
