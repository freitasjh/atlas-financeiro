// O1.5 — hook useOfxImport: pickFile + guard 2MB/5000 linhas + erro honesto antes de ler.
import { useCallback, useState } from 'react'
import { decodeBlob, countOfxLines, OFX_MAX_BYTES, OFX_MAX_LINES } from '@/lib/ofx/decode'

export type OfxGuardError = 'required' | 'too-large' | 'invalid-type' | 'too-many-lines' | 'decode-error'

export interface PickedFileLike {
  name: string
  size: number
}

const ACCEPTED_EXT = /\.(ofx|qfx)$/i

/** Guard síncrono honesto: tamanho + extensão, antes de qualquer leitura. */
export function guardOfxFile(file: PickedFileLike | null | undefined): OfxGuardError | null {
  if (!file) return 'required'
  if (!ACCEPTED_EXT.test(file.name)) return 'invalid-type'
  if (file.size > OFX_MAX_BYTES) return 'too-large'
  return null
}

export function useOfxImport() {
  const [fileName, setFileName] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<OfxGuardError | null>(null)
  const [isReading, setIsReading] = useState(false)

  const reset = useCallback(() => {
    setFileName(null)
    setErrorCode(null)
    setIsReading(false)
  }, [])

  /** Valida, lê e conta linhas; retorna texto ou null com errorCode honesto. */
  const pickFile = useCallback(async (file: File | null): Promise<string | null> => {
    const guard = guardOfxFile(file)
    if (guard) {
      setErrorCode(guard)
      setFileName(null)
      return null
    }
    setIsReading(true)
    try {
      const text = await decodeBlob(file as Blob)
      if (countOfxLines(text) > OFX_MAX_LINES) {
        setErrorCode('too-many-lines')
        setFileName(null)
        return null
      }
      setErrorCode(null)
      setFileName((file as File).name)
      return text
    } catch {
      setErrorCode('decode-error')
      setFileName(null)
      return null
    } finally {
      setIsReading(false)
    }
  }, [])

  return { fileName, errorCode, isReading, pickFile, reset }
}
