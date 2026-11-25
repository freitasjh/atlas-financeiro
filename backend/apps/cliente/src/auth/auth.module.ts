import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { CLIENTE_DB, type NamedDatabase } from '../database/database.tokens';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { DatabaseSessionStore } from './database-session-store';
import { LOGIN_THROTTLE, createLoginThrottle } from './login-throttle';
import { PublicAuthController } from './public-auth.controller';
import { RefreshService } from './refresh-service';
import { RolesGuard } from './roles.guard';
import { SecurityLogger } from './security-logger';
import { SESSION_STORE } from './session-store';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthController, PublicAuthController],
  providers: [
    AuthGuard,
    RolesGuard,
    SecurityLogger,
    { provide: SESSION_STORE, useClass: DatabaseSessionStore },
    { provide: LOGIN_THROTTLE, useFactory: () => createLoginThrottle() },
    {
      provide: RefreshService,
      inject: [CLIENTE_DB, SecurityLogger],
      useFactory: (db: NamedDatabase, security: SecurityLogger) =>
        new RefreshService(db.pool, security),
    },
  ],
  exports: [AuthGuard, RolesGuard, SESSION_STORE],
})
export class AuthModule {}
