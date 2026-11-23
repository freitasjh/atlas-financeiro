import { createPrivateKey, createPublicKey } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';

export type JwtAlgorithm = 'ES256' | 'RS256' | 'HS256';

export interface JwtConfig {
  algorithm: JwtAlgorithm;
  issuer: string;
  audience: string;
  privateKey?: string;
  secret?: string;
  context?: 'cliente' | 'control-plane';
}

export interface Principal {
  sub: string;
  role: string;
  context: 'cliente' | 'control-plane';
  jti?: string;
  mfa: boolean;
}

/** S1: RS256/ES256 preferido; HS256 só com segredo >= 256 bits. `none` nunca. */
export function validateJwtConfig(config: JwtConfig): void {
  if (!config.issuer || !config.audience) {
    throw new Error('issuer e audience são obrigatórios');
  }
  if (config.algorithm === 'HS256') {
    const secret = config.secret ?? '';
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('segredo HS256 deve ter pelo menos 256 bits');
    }
    return;
  }
  if (!config.privateKey) {
    throw new Error('chave privada obrigatória para assinatura assimétrica');
  }
  try {
    createPrivateKey(config.privateKey);
  } catch {
    throw new Error('chave privada inválida');
  }
}

export function verifyToken(token: string, config: JwtConfig): Principal {
  validateJwtConfig(config);

  const verifyOptions: {
    algorithms: JwtAlgorithm[];
    issuer: string;
    audience: string;
    clockTolerance: number;
  } = {
    algorithms: [config.algorithm],
    issuer: config.issuer,
    audience: config.audience,
    clockTolerance: 0,
  };

  const service =
    config.algorithm === 'HS256'
      ? new JwtService({ secret: config.secret, verifyOptions })
      : new JwtService({
          publicKey: createPublicKey(config.privateKey as string),
          verifyOptions,
        });

  let payload: Record<string, unknown>;
  try {
    payload = service.verify<Record<string, unknown>>(token);
  } catch {
    throw new Error('token inválido');
  }

  if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
    throw new Error('claims obrigatórias ausentes');
  }

  return {
    sub: payload.sub,
    role: payload.role,
    context:
      config.context ??
      (config.audience.includes('cliente') ? 'cliente' : 'control-plane'),
    jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    mfa: payload.mfa === true,
  };
}
