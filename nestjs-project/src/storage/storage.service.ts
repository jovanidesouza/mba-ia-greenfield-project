import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import storageConfig from '../config/storage.config';

export interface StorageObjectStream {
  stream: Readable;
  contentLength?: number;
  contentRange?: string;
  totalSize?: number;
  contentType?: string;
  acceptRanges?: string;
}

export interface MultipartPartInput {
  PartNumber: number;
  ETag: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly s3Client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.s3Client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      forcePathStyle: this.config.forcePathStyle,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists(this.config.bucketVideos);
    await this.ensureBucketExists(this.config.bucketThumbnails);
  }

  async ensureBucketExists(bucket: string): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch {
        // Ignored if already created concurrently
      }
    }
  }

  async getPresignedPutUrl(
    bucket: string,
    key: string,
    contentType?: string,
    expiresIn = 3600,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType?: string,
  ): Promise<string> {
    const command = new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const res = await this.s3Client.send(command);
    if (!res.UploadId) {
      throw new Error('Failed to initiate multipart upload: missing UploadId');
    }
    return res.UploadId;
  }

  async getPresignedUploadPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: MultipartPartInput[],
  ): Promise<void> {
    const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const command = new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sortedParts,
      },
    });
    await this.s3Client.send(command);
  }

  async uploadBuffer(
    bucket: string,
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });
    await this.s3Client.send(command);
  }

  async getObjectStream(
    bucket: string,
    key: string,
    range?: string,
  ): Promise<StorageObjectStream> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range,
    });

    const response = await this.s3Client.send(command);
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
      acceptRanges: response.AcceptRanges,
    };
  }
}
