import { ConfigService } from '@nestjs/config';
import { validateJwtConfig, type JwtConfig } from './token-verifier';

export const AUTH_CONTEXT = 'control-plane' as const;
export const JWT_ALGORITHM = 'ES256' as const;

export function buildJwtConfig(config: ConfigService): JwtConfig {
  const jwtConfig: JwtConfig = {
    algorithm: JWT_ALGORITHM,
    issuer: config.getOrThrow<string>('CONTROL_PLANE_JWT_ISSUER'),
    audience: config.getOrThrow<string>('CONTROL_PLANE_JWT_AUDIENCE'),
    privateKey: config.getOrThrow<string>('CONTROL_PLANE_JWT_SECRET'),
    context: AUTH_CONTEXT,
  };
  validateJwtConfig(jwtConfig);
  return jwtConfig;
}
