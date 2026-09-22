import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoQueueProducer } from './video-queue-producer.service';
import { JOB_PROCESS_VIDEO, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import type { ProcessVideoJobPayload } from './interfaces/process-video-job.interface';

describe('QueueModule (integration)', () => {
  let module: TestingModule;
  let producer: VideoQueueProducer;
  let queue: Queue<ProcessVideoJobPayload>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
        }),
        QueueModule,
      ],
    }).compile();

    producer = module.get<VideoQueueProducer>(VideoQueueProducer);
    queue = module.get<Queue<ProcessVideoJobPayload>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    if (queue) {
      await queue.drain();
      await queue.clean(0, 0, 'completed');
      await queue.clean(0, 0, 'failed');
      await queue.close();
    }
    await module.close();
  });

  it('pushes a job to Redis and verifies it is present in the queue', async () => {
    const payload: ProcessVideoJobPayload = {
      videoId: `video-${Date.now()}`,
      storageKey: `videos/key-${Date.now()}.mp4`,
      channelId: 'channel-test-1',
    };

    await producer.addVideoProcessingJob(payload);

    const jobs = await queue.getJobs(['waiting', 'delayed']);
    const found = jobs.find((j) => j.data.videoId === payload.videoId);

    expect(found).toBeDefined();
    expect(found?.name).toBe(JOB_PROCESS_VIDEO);
    expect(found?.data).toEqual(payload);
    expect(found?.opts.attempts).toBe(3);
  });
});
