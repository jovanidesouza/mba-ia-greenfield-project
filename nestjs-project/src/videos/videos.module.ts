import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';
import { StorageModule } from '../storage/storage.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
