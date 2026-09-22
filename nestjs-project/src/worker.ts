import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const logger = new Logger('VideoWorkerMain');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  logger.log('Video worker started and listening for BullMQ jobs...');
}

void bootstrap();
