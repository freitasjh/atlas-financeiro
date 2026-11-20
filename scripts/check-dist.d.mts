export declare const PROJECT_REF_PLACEHOLDER: 'REPLACE_WITH_PROJECT_REF'
export declare const ANON_KEY_PLACEHOLDER: 'REPLACE_WITH_ANON_KEY'

export interface AuditOptions {
  allowPlaceholder?: boolean
}

export interface BundleAuditOptions extends AuditOptions {
  /** Project ref declarado no `connect-src` de `dist/_headers`. */
  expectedRef?: string | null
}

export interface CheckDistOptions extends AuditOptions {
  cwd?: string
  distDir?: string
}

export interface RunCheckDistOptions extends CheckDistOptions {
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}

export interface RunCheckDistResult {
  code: number
  errors: string[]
  warnings: string[]
}

export declare function parseHeaders(text: string): Map<string, string>
export declare function parseCsp(value: string): Map<string, string>
export declare function auditHeaders(text: string, options?: AuditOptions): string[]
export declare function auditIndexHtml(html: string): string[]
export declare function auditBundle(
  code: string,
  name?: string,
  options?: BundleAuditOptions,
): string[]
export declare function projectRefsInText(text: string): Set<string>
export declare function deriveProjectRef(
  env?: Record<string, string | undefined>,
): string | null
export declare function substituteProjectRef(
  template: string,
  ref: string | null | undefined,
): string
export declare function checkDist(options?: CheckDistOptions): string[]
export declare function runCheckDist(options?: RunCheckDistOptions): RunCheckDistResult
