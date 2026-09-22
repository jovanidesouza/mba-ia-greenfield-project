# Library References — Phase 03: Upload e Processamento de Vídeos

## Core Libraries & Official References

### 1. @nestjs/bullmq & bullmq
- **Role:** Distributed background job queue for media processing.
- **Packages:** `@nestjs/bullmq`, `bullmq`, `ioredis`
- **Official Docs Reference:** https://github.com/nestjs/bull
- **Key Concepts:**
  - `BullModule.forRootAsync({ useFactory: ... })` using `@nestjs/config` for Redis connection (`host: 'redis'`, `port: 6379`).
  - `@Processor('video-processing')` extending `WorkerHost` with `process(job: Job): Promise<void>`.
  - Queue registration via `BullModule.registerQueue({ name: 'video-processing' })`.
  - Retry policy with exponential backoff: `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }`.

### 2. @aws-sdk/client-s3 & @aws-sdk/s3-request-presigner
- **Role:** S3/MinIO client for multipart upload orchestration, presigned URLs, and Range 206 streaming.
- **Packages:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- **Key Concepts:**
  - Client setup: `forcePathStyle: true` for MinIO compatibility, credentials from namespaced config (`minioadmin:minioadmin`).
  - Presigned multipart upload: `CreateMultipartUploadCommand`, `UploadPartCommand` wrapped in `getSignedUrl(...)`, and `CompleteMultipartUploadCommand`.
  - Streaming / Partial content: `GetObjectCommand({ Bucket, Key, Range })` returning Node.js `Readable` stream piped to Express `Response` with status `206 Partial Content`.

### 3. fluent-ffmpeg & ffmpeg-static (or system FFmpeg)
- **Role:** Video metadata inspection (duration, resolution) and thumbnail frame extraction.
- **Packages:** `fluent-ffmpeg`, `@types/fluent-ffmpeg`
- **Key Concepts:**
  - `ffprobe(filePath, (err, metadata) => ...)` to extract `metadata.format.duration`, `width`, `height`.
  - `ffmpeg(filePath).screenshots({ count: 1, folder: tmpDir, filename: 'thumb.png', timemarks: ['1'] })`.
