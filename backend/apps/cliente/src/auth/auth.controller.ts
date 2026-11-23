import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';
import { AUTH_CONTEXT } from './jwt-config';
import type { Principal } from './token-verifier';

@Controller('auth')
@UseGuards(AuthGuard, RolesGuard)
export class AuthController {
  @Get('check')
  @Roles('admin')
  check(@Req() request: { principal: Principal }) {
    return {
      authorized: true,
      context: AUTH_CONTEXT,
      role: request.principal.role,
    };
  }
}
