import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';
import { StorageModule } from './storage.module';

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storageService: StorageService;
  const testBucket = 'streamtube-test-bucket';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    await storageService.onModuleInit();
  });

  afterAll(async () => {
    await module.close();
  });

  it('ensures default buckets exist on initialization', async () => {
    await expect(
      storageService.ensureBucketExists('streamtube-videos'),
    ).resolves.not.toThrow();
    await expect(
      storageService.ensureBucketExists('streamtube-thumbnails'),
    ).resolves.not.toThrow();
  });

  it('generates presigned PUT URL for upload', async () => {
    const url = await storageService.getPresignedPutUrl(
      'streamtube-videos',
      'test-key.mp4',
      'video/mp4',
    );
    expect(url).toBeDefined();
    expect(typeof url).toBe('string');
    expect(url).toContain('streamtube-videos/test-key.mp4');
  });

  it('uploads a buffer and reads it back via object stream with range', async () => {
    await storageService.ensureBucketExists(testBucket);
    const content = Buffer.from('0123456789ABCDEF');
    const key = `test-${Date.now()}.txt`;

    await storageService.uploadBuffer(testBucket, key, content, 'text/plain');

    // Full stream
    const full = await storageService.getObjectStream(testBucket, key);
    expect(full.contentType).toBe('text/plain');
    expect(full.contentLength).toBe(16);

    // Read full stream into buffer
    const chunks: Buffer[] = [];
    for await (const chunk of full.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe('0123456789ABCDEF');

    // Partial stream with Range: bytes=0-4
    const partial = await storageService.getObjectStream(
      testBucket,
      key,
      'bytes=0-4',
    );
    expect(partial.contentLength).toBe(5);
    expect(partial.contentRange).toBe('bytes 0-4/16');

    const partialChunks: Buffer[] = [];
    for await (const chunk of partial.stream) {
      partialChunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(partialChunks).toString()).toBe('01234');
  });

  it('handles multipart upload lifecycle: create, part URLs, and complete', async () => {
    await storageService.ensureBucketExists(testBucket);
    const key = `multipart-${Date.now()}.bin`;

    const uploadId = await storageService.createMultipartUpload(
      testBucket,
      key,
      'application/octet-stream',
    );
    expect(uploadId).toBeDefined();
    expect(typeof uploadId).toBe('string');

    const part1Url = await storageService.getPresignedUploadPartUrl(
      testBucket,
      key,
      uploadId,
      1,
    );
    expect(part1Url).toContain(`uploadId=${uploadId}`);
    expect(part1Url).toContain('partNumber=1');

    // Upload part 1 directly via fetch to the presigned part URL (MinIO must accept 5MB+ for multipart or small parts if single part)
    // In S3 standard multipart, parts except the last must be >= 5MB. Let's send a 5MB part.
    const part1Body = Buffer.alloc(5 * 1024 * 1024, 'a');
    const uploadRes = await fetch(part1Url, {
      method: 'PUT',
      body: part1Body,
    });
    expect(uploadRes.status).toBe(200);
    const etag = uploadRes.headers.get('etag');
    expect(etag).toBeDefined();

    await expect(
      storageService.completeMultipartUpload(testBucket, key, uploadId, [
        { PartNumber: 1, ETag: etag! },
      ]),
    ).resolves.not.toThrow();

    // Verify final uploaded object exists
    const streamInfo = await storageService.getObjectStream(testBucket, key);
    expect(streamInfo.contentLength).toBe(5 * 1024 * 1024);
  });
});
