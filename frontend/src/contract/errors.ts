import { fieldErrorEnvelopeSchema, type FieldErrorEnvelope } from './v1'

export function formatFieldError(error: FieldErrorEnvelope): string {
  const parsed = fieldErrorEnvelopeSchema.parse(error)
  return `${parsed.field}: ${parsed.message}`
}

interface IssueLike {
  path: ReadonlyArray<PropertyKey>
}

export function firstFieldName(issues: ReadonlyArray<IssueLike>): string {
  const path = issues[0]?.path
  return path && path.length ? String(path[0]) : '(campo)'
}

export function messageForInvalidField(field: string): string {
  return `${field}: valor rejeitado`
}
