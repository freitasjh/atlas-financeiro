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
  options: {
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    algorithm?: 'ES256' | 'HS256';
    secret?: string;
    context?: 'cliente' | 'control-plane';
  } = {},
): string {
  const context = options.context ?? 'cliente';
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
  return service.sign({ ...claims, context });
}

export function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

export interface TestOverride {
  token: string;
  value: unknown;
}

export async function createTestApp(
  AppModule: any,
  dbToken: string,
  dbValue: unknown,
  overrides: readonly TestOverride[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(dbToken)
    .useValue(dbValue);
  for (const override of overrides) {
    builder = builder.overrideProvider(override.token).useValue(override.value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  await app.init();
  return app;
}
