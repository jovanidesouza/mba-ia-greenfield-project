import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import {
  JOB_PROCESS_VIDEO,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import type { ProcessVideoJobPayload } from '../queue/interfaces/process-video-job.interface';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/enums/video-status.enum';
import { StorageService } from '../storage/storage.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessorWorker extends WorkerHost {
  private readonly logger = new Logger(VideoProcessorWorker.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobPayload>): Promise<void> {
    if (job.name !== JOB_PROCESS_VIDEO) {
      return;
    }

    const { videoId, storageKey } = job.data;
    this.logger.log(
      `Starting video processing for video ${videoId} (job ${job.id})`,
    );

    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found in database. Aborting job.`);
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-proc-'));
    const localVideoPath = path.join(tmpDir, 'source.mp4');
    const localThumbPath = path.join(tmpDir, 'thumb.jpg');

    try {
      // 1. Download file stream from storage to temporary local file
      const objectStream = await this.storageService.getObjectStream(
        'streamtube-videos',
        storageKey,
      );

      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(localVideoPath);
        objectStream.stream.pipe(writeStream);
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
      });

      // 2. Extract video duration and metadata via ffprobe
      const durationSeconds = await this.extractDuration(localVideoPath);

      // 3. Extract thumbnail frame via ffmpeg
      await this.extractThumbnail(
        localVideoPath,
        localThumbPath,
        durationSeconds,
      );

      // 4. Upload thumbnail to storage
      const thumbBuffer = fs.readFileSync(localThumbPath);
      const thumbKey = `thumbnails/${video.channel_id}/${video.slug}/thumb.jpg`;
      await this.storageService.uploadBuffer(
        'streamtube-thumbnails',
        thumbKey,
        thumbBuffer,
        'image/jpeg',
      );

      // 5. Update video status to READY
      video.duration_seconds = durationSeconds;
      video.thumbnail_url = thumbKey;
      video.status = VideoStatus.READY;
      video.error_message = null;
      await this.videoRepository.save(video);

      this.logger.log(
        `Successfully processed video ${videoId}. Status set to READY.`,
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error processing video ${videoId}: ${errorMsg}`);

      // If attempts are exhausted or it's a fatal parse error, mark as FAILED
      video.status = VideoStatus.FAILED;
      video.error_message = errorMsg;
      await this.videoRepository.save(video);

      throw err; // Rethrow to let BullMQ handle retry attempts
    } finally {
      // Cleanup temporary files
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  protected extractDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          return reject(err instanceof Error ? err : new Error(String(err)));
        }
        const rawDuration = metadata.format.duration;
        const duration = rawDuration ? Math.round(Number(rawDuration)) : 0;
        resolve(duration);
      });
    });
  }

  protected extractThumbnail(
    videoPath: string,
    outputPath: string,
    durationSeconds: number,
  ): Promise<void> {
    const timestamp = durationSeconds > 1 ? '1.0' : '0.1';
    const folder = path.dirname(outputPath);
    const filename = path.basename(outputPath);

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          count: 1,
          folder,
          filename,
          timemarks: [timestamp],
          size: '640x360',
        })
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });
  }
}
