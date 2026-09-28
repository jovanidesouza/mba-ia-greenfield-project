import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadIdToVideos1790630240384 implements MigrationInterface {
  name = 'AddUploadIdToVideos1790630240384';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "upload_id" character varying(500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "upload_id"`);
  }
}
