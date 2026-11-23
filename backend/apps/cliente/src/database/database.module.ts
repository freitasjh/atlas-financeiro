import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CLIENTE_DB } from './database.tokens';
import { databaseProvider } from './database.providers';

@Module({
  imports: [ConfigModule],
  providers: [databaseProvider],
  exports: [CLIENTE_DB],
})
export class DatabaseModule {}
