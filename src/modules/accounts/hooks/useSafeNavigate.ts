// Navegação opcional a Router: fora de um <Router> retorna null para o
// chamador usar fallback honesto (hash) em vez de quebrar. Mantém os testes
// de picker/view sem Router verdes e a navegação real via useNavigate.
import { useNavigate, type NavigateFunction } from 'react-router-dom'

export function useSafeNavigate(): NavigateFunction | null {
  try {
    return useNavigate()
  } catch {
    return null
  }
}
