import { generateKeyPairSync } from 'node:crypto';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface TestEnv {
  privateKey: string;
  issuer: string;
  audience: string;
}

export function configureEnv(): TestEnv {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.CLIENTE_DATABASE_URL = 'env-injetada-pelo-teste';
  process.env.CLIENTE_JWT_SECRET = pem;
  process.env.CLIENTE_JWT_ISSUER = 'https://issuer.test/cliente';
  process.env.CLIENTE_JWT_AUDIENCE = 'atlas-cliente';
  return {
    privateKey: pem,
    issuer: process.env.CLIENTE_JWT_ISSUER,
    audience: process.env.CLIENTE_JWT_AUDIENCE,
  };
}

export function signToken(
  env: TestEnv,
  claims: Record<string, unknown>,
  options: { issuer?: string; audience?: string; expiresIn?: string; algorithm?: 'ES256' | 'HS256'; secret?: string } = {},
): string {
  const service = options.algorithm === 'HS256'
    ? new JwtService({
        secret: options.secret ?? 'a'.repeat(32),
        signOptions: {
          algorithm: 'HS256',
          issuer: options.issuer ?? env.issuer,
          audience: options.audience ?? env.audience,
          expiresIn: (options.expiresIn ?? '5m') as never,
        },
      })
    : new JwtService({
        privateKey: env.privateKey,
        signOptions: {
          algorithm: 'ES256',
          issuer: options.issuer ?? env.issuer,
          audience: options.audience ?? env.audience,
          expiresIn: (options.expiresIn ?? '5m') as never,
        },
      });
  return service.sign(claims);
}

export function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

export async function createTestApp(
  AppModule: any,
  dbToken: string,
  dbValue: unknown,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(dbToken)
    .useValue(dbValue)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  await app.init();
  return app;
}
