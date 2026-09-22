import * as fs from 'fs';
import { Readable } from 'stream';
import type { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import { VideoProcessorWorker } from './video-processor.worker';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/enums/video-status.enum';
import { StorageService } from '../storage/storage.service';
import { JOB_PROCESS_VIDEO } from '../queue/queue.constants';
import type { ProcessVideoJobPayload } from '../queue/interfaces/process-video-job.interface';

class TestableVideoProcessorWorker extends VideoProcessorWorker {
  override extractDuration(): Promise<number> {
    return Promise.resolve(125);
  }

  override extractThumbnail(
    _videoPath: string,
    outputPath: string,
  ): Promise<void> {
    fs.writeFileSync(outputPath, Buffer.from('mock thumbnail image'));
    return Promise.resolve();
  }
}

describe('VideoProcessorWorker (unit)', () => {
  let worker: TestableVideoProcessorWorker;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(() => {
    videoRepository = {
      findOneBy: jest.fn(),
      save: jest
        .fn()
        .mockImplementation((entity: Video) => Promise.resolve(entity)),
    } as unknown as jest.Mocked<Repository<Video>>;

    storageService = {
      getObjectStream: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('mock video bytes')]),
      }),
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StorageService>;

    worker = new TestableVideoProcessorWorker(videoRepository, storageService);
  });

  it('ignores jobs with different job name', async () => {
    const job = {
      id: 'job-1',
      name: 'other-job',
      data: { videoId: 'v1', storageKey: 'key', channelId: 'c1' },
    } as Job<ProcessVideoJobPayload>;

    await worker.process(job);

    expect(videoRepository.findOneBy).not.toHaveBeenCalled();
  });

  it('aborts when video is not found in database', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    const job = {
      id: 'job-1',
      name: JOB_PROCESS_VIDEO,
      data: { videoId: 'non-existent', storageKey: 'key', channelId: 'c1' },
    } as Job<ProcessVideoJobPayload>;

    await worker.process(job);

    expect(storageService.getObjectStream).not.toHaveBeenCalled();
  });

  it('processes video successfully: extracts duration, uploads thumbnail, updates to READY', async () => {
    const video = {
      id: 'video-123',
      channel_id: 'channel-456',
      slug: 'slug123',
      status: VideoStatus.PROCESSING,
    } as Video;
    videoRepository.findOneBy.mockResolvedValue(video);

    const job = {
      id: 'job-1',
      name: JOB_PROCESS_VIDEO,
      data: {
        videoId: 'video-123',
        storageKey: 'videos/channel-456/slug123/video.mp4',
        channelId: 'channel-456',
      },
    } as Job<ProcessVideoJobPayload>;

    await worker.process(job);

    expect(storageService.getObjectStream).toHaveBeenCalledWith(
      'streamtube-videos',
      'videos/channel-456/slug123/video.mp4',
    );
    expect(storageService.uploadBuffer).toHaveBeenCalledWith(
      'streamtube-thumbnails',
      'thumbnails/channel-456/slug123/thumb.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBe(125);
    expect(video.thumbnail_url).toBe(
      'thumbnails/channel-456/slug123/thumb.jpg',
    );
    expect(videoRepository.save).toHaveBeenCalledWith(video);
  });

  it('marks video as FAILED and rethrows when storage stream fails', async () => {
    const video = {
      id: 'video-123',
      channel_id: 'channel-456',
      slug: 'slug123',
      status: VideoStatus.PROCESSING,
    } as Video;
    videoRepository.findOneBy.mockResolvedValue(video);

    storageService.getObjectStream.mockRejectedValue(
      new Error('S3 connection timeout'),
    );

    const job = {
      id: 'job-1',
      name: JOB_PROCESS_VIDEO,
      data: {
        videoId: 'video-123',
        storageKey: 'videos/channel-456/slug123/video.mp4',
        channelId: 'channel-456',
      },
    } as Job<ProcessVideoJobPayload>;

    await expect(worker.process(job)).rejects.toThrow('S3 connection timeout');
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.error_message).toBe('S3 connection timeout');
    expect(videoRepository.save).toHaveBeenCalledWith(video);
  });
});
