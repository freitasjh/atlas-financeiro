import { Controller, Get, Inject, Res } from '@nestjs/common';
import { AUTH_CONTEXT } from '../auth/jwt-config';
import { CONTROL_PLANE_DB, type NamedDatabase } from '../database/database.tokens';

@Controller('health')
export class HealthController {
  constructor(@Inject(CONTROL_PLANE_DB) private readonly db: NamedDatabase) {}

  @Get()
  async health(@Res({ passthrough: true }) response: { status(code: number): void }) {
    const up = await this.db.probe();
    if (!up) {
      response.status(503);
      return { status: 'degraded', db: 'down' };
    }
    return { status: 'ok', db: 'up', context: AUTH_CONTEXT };
  }
}
