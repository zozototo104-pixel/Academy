export type UsdtVerificationStatus = 'VERIFIED' | 'FAILED' | 'WAITING_TX' | 'UNSUPPORTED'

export interface UsdtVerificationInput {
  txHash: string
  network?: string | null
  expectedWallet: string
  expectedAmount: number
}

export interface UsdtVerificationResult {
  status: UsdtVerificationStatus
  note: string
  amount?: number | null
  toAddress?: string | null
  token?: string | null
  explorerUrl?: string | null
  raw?: any
}

function cleanTxHash(value: string) {
  return String(value || '').trim()
}

function normalizeNetwork(value?: string | null) {
  const v = String(value || 'TRC20').trim().toUpperCase()
  if (v.includes('TRON') || v.includes('TRC')) return 'TRC20'
  if (v.includes('BEP') || v.includes('BSC')) return 'BEP20'
  if (v.includes('ERC') || v.includes('ETH')) return 'ERC20'
  return v || 'TRC20'
}

function looksLikeHash(hash: string) {
  const h = hash.replace(/^0x/i, '')
  return /^[a-fA-F0-9]{64}$/.test(h)
}

function sameAddress(a?: string | null, b?: string | null) {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return false
  if (x.startsWith('0x') || y.startsWith('0x')) return x.toLowerCase() === y.toLowerCase()
  return x === y
}

function parseTokenAmount(rawAmount: any, decimals: any) {
  const raw = String(rawAmount ?? '').trim()
  if (!raw) return null
  if (raw.includes('.')) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const d = Number(decimals)
  if (Number.isFinite(d) && d > 0 && raw.length > Math.max(1, d)) return n / Math.pow(10, d)
  return n
}

function tronExplorer(hash: string) {
  return `https://tronscan.org/#/transaction/${hash}`
}

function extractTronTransfers(data: any) {
  const transfers: Array<{ token?: string | null; amount?: number | null; to?: string | null; raw: any }> = []
  const arrays = [data?.trc20TransferInfo, data?.trc20TransferInfoList, data?.tokenTransferInfo ? [data.tokenTransferInfo] : null]
    .filter(Boolean) as any[]
  for (const arr of arrays) {
    for (const item of Array.isArray(arr) ? arr : []) {
      const token = item?.symbol || item?.tokenAbbr || item?.tokenName || item?.name || item?.tokenInfo?.tokenAbbr || item?.tokenInfo?.tokenName || null
      const amount = parseTokenAmount(item?.amount_str ?? item?.amount ?? item?.quant ?? item?.value, item?.decimals ?? item?.tokenDecimal ?? item?.tokenInfo?.tokenDecimal)
      const to = item?.to_address || item?.toAddress || item?.to || item?.transferToAddress || null
      transfers.push({ token, amount, to, raw: item })
    }
  }
  return transfers
}

async function verifyTrc20(input: UsdtVerificationInput): Promise<UsdtVerificationResult> {
  const txHash = cleanTxHash(input.txHash)
  const url = `https://apilist.tronscanapi.com/api/transaction-info?hash=${encodeURIComponent(txHash)}`
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!res.ok) {
    return { status: 'WAITING_TX', note: `تعذر الاتصال بخدمة التحقق من TRON حالياً (${res.status}). حاول لاحقاً أو راجع المعاملة يدوياً.`, explorerUrl: tronExplorer(txHash) }
  }
  const data = await res.json()
  if (!data || data?.Error || data?.error) {
    return { status: 'WAITING_TX', note: 'لم تظهر المعاملة على شبكة TRON بعد. تأكد من Hash العملية أو انتظر التأكيدات.', explorerUrl: tronExplorer(txHash), raw: data }
  }
  const failed = String(data?.contractRet || data?.receipt?.result || '').toUpperCase().includes('FAIL') || String(data?.contractRet || '').toUpperCase().includes('REVERT')
  const transfers = extractTronTransfers(data)
  const match = transfers.find((t) => {
    const contractAddress = t.raw?.contract_address || t.raw?.contractAddress || t.raw?.contract || null
    const tokenOk = String(t.token || '').toUpperCase().includes('USDT') || sameAddress(contractAddress, 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj')
    const toOk = sameAddress(t.to, input.expectedWallet)
    const amountOk = typeof t.amount === 'number' && t.amount + 0.000001 >= Number(input.expectedAmount || 0)
    return tokenOk && toOk && amountOk
  })
  if (failed) {
    return { status: 'FAILED', note: 'المعاملة موجودة لكنها فاشلة أو مرتدة على الشبكة.', explorerUrl: tronExplorer(txHash), raw: data }
  }
  if (!match) {
    const first = transfers[0]
    return {
      status: 'FAILED',
      note: transfers.length
        ? `تم العثور على المعاملة، لكن لم نجد تحويل USDT مطابقاً للمحفظة والمبلغ المطلوب. أول تحويل ظاهر: ${first?.amount ?? 'غير معروف'} ${first?.token || ''} إلى ${first?.to || 'غير معروف'}.`
        : 'تم العثور على المعاملة، لكن لم نجد تحويل TRC20/USDT واضحاً داخلها.',
      amount: first?.amount ?? null,
      toAddress: first?.to ?? null,
      token: first?.token ?? null,
      explorerUrl: tronExplorer(txHash),
      raw: data,
    }
  }
  return {
    status: 'VERIFIED',
    note: `تم التحقق آلياً: تحويل ${match.amount} USDT إلى المحفظة المطلوبة. بانتظار تأكيد الإدارة النهائي.`,
    amount: match.amount ?? null,
    toAddress: match.to ?? null,
    token: match.token || 'USDT',
    explorerUrl: tronExplorer(txHash),
    raw: data,
  }
}

export async function verifyUsdtTransaction(input: UsdtVerificationInput): Promise<UsdtVerificationResult> {
  const txHash = cleanTxHash(input.txHash)
  if (!txHash) return { status: 'WAITING_TX', note: 'أدخل TX Hash الخاص بعملية التحويل أولاً.' }
  if (!looksLikeHash(txHash)) return { status: 'FAILED', note: 'صيغة TX Hash غير صحيحة. يجب أن يكون 64 خانة Hex غالباً.' }
  const network = normalizeNetwork(input.network)
  if (network === 'TRC20') return verifyTrc20({ ...input, txHash, network })
  return {
    status: 'UNSUPPORTED',
    note: `التحقق الآلي للشبكة ${network} غير مفعل حالياً. يمكن للإدارة مراجعة Hash يدوياً قبل التأكيد.`,
    explorerUrl: txHash.startsWith('0x') ? `https://etherscan.io/tx/${txHash}` : undefined,
  }
}
