import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video } from './video.entity';
import { VideoStatus } from '../enums/video-status.enum';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

describe('Video Entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    dataSource = createTestDataSource([
      User,
      Channel,
      RefreshToken,
      VerificationToken,
      Video,
    ]);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createTestChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video-test-${Date.now()}@example.com`,
        password: 'hashedpassword',
        is_confirmed: true,
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Test Channel',
        nickname: `testchannel_${Date.now()}`,
        user_id: user.id,
      }),
    );
  }

  it('persists a video in DRAFT status with default values', async () => {
    const channel = await createTestChannel();
    const video = videoRepository.create({
      channel_id: channel.id,
      title: 'My First Video',
      description: 'A test video description',
      slug: 'slug12345678',
      storage_key: 'videos/channel1/slug12345678/test.mp4',
    });

    const saved = await videoRepository.save(video);

    expect(saved.id).toBeDefined();
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.duration_seconds).toBeNull();
    expect(saved.thumbnail_url).toBeNull();
    expect(saved.error_message).toBeNull();
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('enforces unique constraint on slug', async () => {
    const channel = await createTestChannel();
    const video1 = videoRepository.create({
      channel_id: channel.id,
      title: 'First Video',
      slug: 'duplicate_slug',
      storage_key: 'videos/key1.mp4',
    });
    await videoRepository.save(video1);

    const video2 = videoRepository.create({
      channel_id: channel.id,
      title: 'Second Video',
      slug: 'duplicate_slug',
      storage_key: 'videos/key2.mp4',
    });

    await expect(videoRepository.save(video2)).rejects.toThrow();
  });

  it('cascades delete when the channel is deleted', async () => {
    const channel = await createTestChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Cascade Video',
        slug: 'cascade_slug',
        storage_key: 'videos/cascade.mp4',
      }),
    );

    await channelRepository.delete(channel.id);

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found).toBeNull();
  });
});
