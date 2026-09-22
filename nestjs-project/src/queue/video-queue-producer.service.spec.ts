import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { VideoQueueProducer } from './video-queue-producer.service';
import { JOB_PROCESS_VIDEO, VIDEO_PROCESSING_QUEUE } from './queue.constants';

describe('VideoQueueProducer (unit)', () => {
  let producer: VideoQueueProducer;
  let mockQueue: { add: jest.Mock };

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoQueueProducer,
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    producer = module.get<VideoQueueProducer>(VideoQueueProducer);
  });

  it('enqueues video processing job with 3 attempts and exponential backoff', async () => {
    const payload = {
      videoId: 'video-123',
      storageKey: 'videos/channel-1/test.mp4',
      channelId: 'channel-1',
    };

    await producer.addVideoProcessingJob(payload);

    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      JOB_PROCESS_VIDEO,
      payload,
      expect.objectContaining({
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      }),
    );
  });
});
