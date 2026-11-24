import type { CardBrand } from '../model/credit-card'

// Rótulo de bandeira (view-only): nomes próprios sem tradução + "outra" via i18n.
export function cardBrandLabel(brand: CardBrand, otherLabel: string): string {
  switch (brand) {
    case 'visa':
      return 'Visa'
    case 'mastercard':
      return 'Mastercard'
    case 'amex':
      return 'Amex'
    case 'elo':
      return 'Elo'
    case 'hipercard':
      return 'Hipercard'
    default:
      return otherLabel
  }
}
