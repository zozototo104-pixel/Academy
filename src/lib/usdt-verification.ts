export type UsdtVerificationStatus = 'VERIFIED' | 'FAILED' | 'UNSUPPORTED'

export interface UsdtVerificationResult {
  status: UsdtVerificationStatus
  note: string
  amount?: number
  txHash?: string
  raw?: Record<string, unknown>
}

const TRC20_USDT_CONTRACTS = new Set([
  'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj',
  '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
].map((v) => v.toLowerCase()))

function env(name: string): string {
  try {
    return process.env[name] || ''
  } catch {
    return ''
  }
}

function normalize(value?: string | null): string {
  return String(value || '').trim().toLowerCase()
}

function validTxHash(txHash: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(txHash.trim())
}

function numberFromTokenValue(value: unknown): number | null {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n / 1_000_000
}

function compactRaw(data: any): Record<string, unknown> {
  const events = Array.isArray(data?.data) ? data.data.slice(0, 5) : []
  return {
    success: data?.success,
    eventCount: Array.isArray(data?.data) ? data.data.length : 0,
    events: events.map((event: any) => ({
      event_name: event?.event_name,
      contract_address: event?.contract_address,
      result: event?.result,
      block_timestamp: event?.block_timestamp,
      transaction_id: event?.transaction_id,
    })),
  }
}

export async function verifyUsdtTransaction(params: {
  txHash: string
  network: string
  walletAddress: string
  expectedAmount: number
}): Promise<UsdtVerificationResult> {
  const txHash = params.txHash.trim()
  const network = normalize(params.network || 'TRC20')
  const walletAddress = params.walletAddress.trim()
  const expectedAmount = Number(params.expectedAmount || 0)

  if (!validTxHash(txHash)) {
    return { status: 'FAILED', note: 'صيغة TX Hash غير صحيحة. يجب أن يكون 64 حرفاً hexadecimal.', txHash }
  }
  if (!walletAddress) {
    return { status: 'FAILED', note: 'عنوان محفظة USDT غير مضبوط في إعدادات الدفع.', txHash }
  }
  if (!expectedAmount || expectedAmount <= 0) {
    return { status: 'FAILED', note: 'قيمة الفاتورة غير صالحة للتحقق.', txHash }
  }
  if (!['trc20', 'tron'].includes(network)) {
    return {
      status: 'UNSUPPORTED',
      note: `التحقق الآلي متاح حالياً لشبكة TRC20 فقط. الشبكة الحالية: ${params.network || 'غير محددة'}.`,
      txHash,
    }
  }

  const base = (env('TRONGRID_API_BASE') || 'https://api.trongrid.io').replace(/\/$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  const apiKey = env('TRONGRID_API_KEY')
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey

  try {
    const res = await fetch(`${base}/v1/transactions/${encodeURIComponent(txHash)}/events?only_confirmed=true`, {
      headers,
      cache: 'no-store',
    })
    const data: any = await res.json().catch(() => ({}))
    const raw = compactRaw(data)
    if (!res.ok) {
      return { status: 'FAILED', note: data?.error || data?.message || 'تعذر الاتصال بخدمة التحقق من شبكة TRON.', txHash, raw }
    }

    const events: any[] = Array.isArray(data?.data) ? data.data : []
    if (!events.length) {
      return { status: 'FAILED', note: 'لم يتم العثور على تحويل USDT مؤكد بهذا TX Hash بعد. تأكد من اكتمال التأكيدات أو أعد المحاولة لاحقاً.', txHash, raw }
    }

    const wallet = normalize(walletAddress)
    const transferEvents = events.filter((event) => normalize(event?.event_name) === 'transfer')
    const matches = transferEvents
      .map((event) => {
        const result = event?.result || {}
        const to = result.to || result._to || result.receiver || result.owner_address
        const value = result.value ?? result._value ?? result.amount
        const contract = event?.contract_address
        const amount = numberFromTokenValue(value)
        return { event, to: normalize(to), contract: normalize(contract), amount }
      })
      .filter((item) => item.to === wallet)

    if (!matches.length) {
      return { status: 'FAILED', note: 'تم العثور على العملية، لكنها لا تحتوي على تحويل إلى عنوان محفظة المنصة المضبوط.', txHash, raw }
    }

    const tokenMatches = matches.filter((item) => item.contract && TRC20_USDT_CONTRACTS.has(item.contract))
    if (!tokenMatches.length) {
      return { status: 'FAILED', note: 'التحويل لا يبدو أنه على عقد USDT TRC20 المعتمد.', txHash, raw }
    }

    const best = tokenMatches.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0]
    const amount = Number(best?.amount || 0)
    if (!amount || amount + 0.000001 < expectedAmount) {
      return { status: 'FAILED', note: `قيمة التحويل (${amount || 0} USDT) أقل من قيمة الفاتورة (${expectedAmount} USDT).`, amount, txHash, raw }
    }

    return {
      status: 'VERIFIED',
      note: `تم التحقق آلياً من تحويل ${amount} USDT إلى محفظة المنصة على شبكة TRC20. بانتظار تأكيد الإدارة النهائي.`,
      amount,
      txHash,
      raw,
    }
  } catch (e: any) {
    return { status: 'FAILED', note: `تعذر تنفيذ التحقق الآلي: ${String(e?.message || e)}`, txHash }
  }
}
