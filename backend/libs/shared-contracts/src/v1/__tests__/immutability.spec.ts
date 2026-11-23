import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const V1_DIR = path.resolve(__dirname, '..');

describe('imutabilidade e escopo de v1', () => {
  it('whenV1SourcesRead_thenAllUseStrictObjectAndLiteralVersion', () => {
    const files = readdirSync(V1_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(path.join(V1_DIR, file), 'utf8');
      expect(source, `${file} deve usar strictObject`).toMatch(/strictObject/);
      expect(source, `${file} deve fixar version v1`).toMatch(/version:\s*z\.literal\('v1'\)/);
      expect(source, `${file} nao pode usar z.object`).not.toMatch(/z\.object\s*\(/);
    }
  });

  it('whenLibraryScanned_thenNoProviderOrEntityIsExported', () => {
    const files = readdirSync(V1_DIR).filter((name) => name.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(path.join(V1_DIR, file), 'utf8');
      const forbidden = new RegExp(
        [
          ['Drizzle', 'Module'].join(''),
          ['@', 'Entity'].join(''),
          ['Repo', 'sitory'].join(''),
        ].join('|'),
      );
      expect(source, `${file} nao deve exportar provider`).not.toMatch(forbidden);
    }
  });
});
