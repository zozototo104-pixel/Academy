export function dollarsToCents(amount: number | string | null | undefined): number {
  const value = Number(amount)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('INVALID_MONEY_AMOUNT')
  }
  return Math.round(value * 100)
}

export function centsToDollars(cents: number | null | undefined): number {
  const value = Number(cents)
  if (!Number.isFinite(value)) return 0
  return value / 100
}

export function paymentAmountCents(payment: { amountCents?: number | null; amount?: number | null }): number {
  if (Number.isSafeInteger(payment.amountCents) && Number(payment.amountCents) >= 0) {
    return Number(payment.amountCents)
  }
  return dollarsToCents(payment.amount ?? 0)
}

export function paymentAmountDollars(payment: { amountCents?: number | null; amount?: number | null }): number {
  if (Number.isSafeInteger(payment.amountCents) && Number(payment.amountCents) >= 0) {
    return centsToDollars(Number(payment.amountCents))
  }
  const value = Number(payment.amount ?? 0)
  return Number.isFinite(value) ? value : 0
}

export function moneyDisplay(payment: { amountCents?: number | null; amount?: number | null }): string {
  return paymentAmountDollars(payment).toFixed(2)
}
