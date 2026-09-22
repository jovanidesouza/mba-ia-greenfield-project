import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JOB_PROCESS_VIDEO, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import type { ProcessVideoJobPayload } from './interfaces/process-video-job.interface';

@Injectable()
export class VideoQueueProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobPayload>,
  ) {}

  async addVideoProcessingJob(payload: ProcessVideoJobPayload): Promise<void> {
    await this.videoQueue.add(JOB_PROCESS_VIDEO, payload, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
