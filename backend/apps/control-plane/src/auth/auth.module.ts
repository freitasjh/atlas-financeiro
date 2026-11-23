import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { SESSION_STORE, createInMemorySessionStore } from './session-store';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [
    AuthGuard,
    RolesGuard,
    { provide: SESSION_STORE, useFactory: createInMemorySessionStore },
  ],
  exports: [AuthGuard, RolesGuard, SESSION_STORE],
})
export class AuthModule {}
