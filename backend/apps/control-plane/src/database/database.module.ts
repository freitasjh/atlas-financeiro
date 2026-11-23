import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CONTROL_PLANE_DB } from './database.tokens';
import { databaseProvider } from './database.providers';

@Module({
  imports: [ConfigModule],
  providers: [databaseProvider],
  exports: [CONTROL_PLANE_DB],
})
export class DatabaseModule {}
