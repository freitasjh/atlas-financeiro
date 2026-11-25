import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND_ROOT = path.resolve(__dirname, '../../../../frontend');
const MANIFEST_PATH = path.join(FRONTEND_ROOT, 'docs/debt-files.json');

// Tokens montados em partes: o validador não traz o literal que procura (regra do gate de dívida).
const DEBT_TOKEN = ['supa', 'base'].join('');
const DEBT_MARKER = ['DEBT', 'SUPABASE'].join('-');

interface MigratedEntry {
  path: string;
  motivo: string;
}

interface DebtManifest {
  version: number;
  generated: string;
  marker: string;
  description: string;
  source: string;
  files: string[];
  dono?: string;
  revisado_por?: string;
  data?: string;
  authMigratedToNest?: MigratedEntry[];
}

/** Saídas do acoplamento de auth (AUTH-10) — nunca reintroduzir como dívida. */
const MIGRATED_AUTH: readonly string[] = [
  'src/components/shadcn/auth/__tests__/auth-surface-i18n-touch.spec.tsx',
  'src/components/shadcn/auth/login-form.test.tsx',
  'src/components/shadcn/auth/login-form.tsx',
  'src/pages/LoginPage.tsx',
  'src/store/auth-store.test.ts',
  'src/store/auth-store.ts',
];

/** Pontos que seguem dívida: recuperação/senha e serviços de dados. */
const STILL_DEBT: readonly string[] = [
  'src/components/shadcn/auth/forgot-password-form.tsx',
  'src/internal/data/internal-client.ts',
  'src/pages/SetPasswordPage.tsx',
];

function readManifest(): DebtManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as DebtManifest;
}

function ownershipErrors(manifest: DebtManifest): string[] {
  const errors: string[] = [];
  if (manifest.dono !== 'frontend-engineer') errors.push('dono');
  if (manifest.revisado_por !== 'code-reviewer') errors.push('revisado_por');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.data ?? '')) errors.push('data');
  return errors;
}

describe('AUTH-13 — inventário de dívida honesto (102 entradas + 6 saídas migradas)', () => {
  it('whenInventoryValidated_then102DebtEntriesPreserved', () => {
    const manifest = readManifest();

    expect(manifest.marker).toBe(DEBT_MARKER);
    expect(manifest.files).toHaveLength(102);
    expect(new Set(manifest.files).size, 'entradas duplicadas').toBe(102);

    for (const rel of manifest.files) {
      const abs = path.join(FRONTEND_ROOT, rel);
      expect(existsSync(abs), `${rel} inexistente`).toBe(true);
      expect(
        readFileSync(abs, 'utf8').toLowerCase().includes(DEBT_TOKEN),
        `${rel} sem token real de acoplamento`,
      ).toBe(true);
    }

    for (const rel of STILL_DEBT) {
      expect(manifest.files, `${rel} não pode sair da dívida`).toContain(rel);
    }
  });

  it('whenOwnerOrReviewerMissing_thenFails', () => {
    const manifest = readManifest();

    expect(ownershipErrors(manifest), 'manifesto real sem dono/revisão/data').toEqual([]);

    const broken = { ...manifest, dono: undefined, revisado_por: undefined, data: undefined };
    expect(ownershipErrors(broken)).toEqual(['dono', 'revisado_por', 'data']);
  });

  it('whenMigratedAuthCallsListed_thenNoFakeDebt', () => {
    const manifest = readManifest();
    const migrated = manifest.authMigratedToNest ?? [];

    expect(migrated.map((entry) => entry.path)).toEqual([...MIGRATED_AUTH]);
    for (const entry of migrated) {
      expect(entry.motivo, `${entry.path} sem motivo`).toBeTruthy();
      expect(manifest.files, `${entry.path} reintroduzido como dívida falsa`).not.toContain(entry.path);

      const abs = path.join(FRONTEND_ROOT, entry.path);
      expect(existsSync(abs), `${entry.path} inexistente`).toBe(true);
      expect(
        readFileSync(abs, 'utf8').toLowerCase().includes(DEBT_TOKEN),
        `${entry.path} ainda acoplado — não é saída migrada`,
      ).toBe(false);
    }
  });
});
