// O1.1 — decode OFX: bytes → texto via TextDecoder windows-1252 com fallback UTF-8.
// Sem float, sem DOMParser; puro TextDecoder.

export const OFX_MAX_BYTES = 2 * 1024 * 1024
export const OFX_MAX_LINES = 5000

/** Decodifica bytes OFX preservando acentos (Itaú/Bradesco çãõ). */
export function decodeOfxBytes(bytes: Uint8Array): string {
  // Tenta UTF-8 estrito primeiro (Nubank QFX moderno); se falhar, windows-1252.
  try {
    const strict = new TextDecoder('utf-8', { fatal: true })
    const text = strict.decode(bytes)
    // UTF-8 válido: usa direto.
    return text
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** Lê Blob/File via arrayBuffer (FileReader moderno) + decode. */
export async function decodeBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  return decodeOfxBytes(new Uint8Array(buffer))
}

/** Alias de domínio: arquivo → texto. */
export const decodeFile = decodeBlob

/** Conta linhas (para guard 5000 antes do parse). */
export function countOfxLines(text: string): number {
  if (text === '') return 0
  let count = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') count += 1
  }
  return count
}
