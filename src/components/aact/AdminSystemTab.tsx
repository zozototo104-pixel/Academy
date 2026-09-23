'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Loader2, Mail, CreditCard, Network, SendHorizonal, ShieldCheck, Save,
  CheckCircle2, XCircle, Clock3, Info, Bot, Radio,
} from 'lucide-react'

interface EmailLog {
  id: string
  to: string
  subject: string
  event: string
  status: string
  error?: string | null
  createdAt: string
}

interface PaymentMethodStatus {
  id: string
  label: string
  enabled: boolean
  configured: boolean
  kind: 'gateway' | 'manual' | 'placeholder'
  reason?: string
}

interface PaymentDiagnostics {
  mode: 'SANDBOX' | 'LIVE'
  sandboxAllowed: boolean
  stripeConfigured: boolean
  stripeWebhookConfigured: boolean
  stripeKeyKind: 'live' | 'test' | 'unknown' | 'missing'
  paypalConfigured: boolean
  paypalApiBase: string
  paypalBaseKind: 'live' | 'sandbox' | 'custom' | 'missing'
  usdtConfigured?: boolean
  usdtNetwork?: string
  trueGatewayCount: number
  warnings: string[]
  errors: string[]
  methods: PaymentMethodStatus[]
}

interface LaunchReadinessItem {
  id: string
  label: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

interface BackupStatus {
  configured: {
    secretConfigured: boolean
    storageConfigured: boolean
    localFallbackAllowed: boolean
    includeSessions: boolean
    tableCount: number
  }
  recent: Array<{ id: string; action: string; entityId?: string | null; details?: string | null; createdAt: string }>
}

interface BackupRunResult {
  ok: boolean
  fileName: string
  exportedAt: string
  durationMs: number
  tables: number
  counts: Record<string, number>
  errors: Array<{ table: string; error: string }>
  storage: { provider: string; key: string; url: string; size: number; mimeType: string }
  checksum: { sha256: string; uncompressedSha256: string; uncompressedBytes: number; compressedBytes: number }
}

interface SystemData {
  values: Record<string, string>
  secretsSet: Record<string, boolean>
  smtpEnabled: boolean
  resendConfigured?: boolean
  paymentMode: string
  payment?: PaymentDiagnostics
  launchReadiness?: LaunchReadinessItem[]
  turnConfigured: boolean
  gemini?: {
    source: 'env' | 'db' | 'none'
    adminKeySet: boolean
    envKeySet: boolean
    activeMask: string
  }
  textAi?: {
    selectedProvider: 'GEMINI' | 'OPENAI' | 'ANTHROPIC' | 'ZAI' | 'GROQ' | 'OPENROUTER' | 'DEEPINFRA' | 'TOGETHER' | 'UNOROUTER' | 'RELAYROUTER' | 'OPENAI_COMPAT' | 'AUTO'
    activeProvider: 'GEMINI' | 'OPENAI' | 'ANTHROPIC' | 'ZAI' | 'GROQ' | 'OPENROUTER' | 'DEEPINFRA' | 'TOGETHER' | 'UNOROUTER' | 'RELAYROUTER' | 'OPENAI_COMPAT' | null
    policy?: 'primary_first' | 'balanced' | 'quality_first' | 'cost_saver' | 'fallback_only'
    externalConfigured: boolean
    keyCounts?: Record<string, number>
    cooldowns?: Array<{ provider: string; key: string; until: string; reason: string }>
    lastResult?: { provider: string; model: string; ok: boolean; error?: string; at: string } | null
    openaiConfigured: boolean
    anthropicConfigured: boolean
    zaiConfigured: boolean
    openaiModel: string
    anthropicModel: string
    zaiModel: string
    message: string
  }
  agent?: {
    enabled: boolean
    provider: 'LOCAL_OPENAI' | 'GEMINI' | 'AUTO'
    source: 'settings' | 'env' | 'none'
    baseUrl: string
    model: string
  }
  emails: EmailLog[]
}

const GEMINI_SUPERVISOR_LIVE_MODEL_CHOICES = [
  { value: 'gemini-3.8-live', label: 'Gemini 3.8 Live — المشرف الذكي / أقل تأخير' },
  { value: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview — احتياطي' },
  { value: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash Native Audio — توافق قديم' },
]

const GEMINI_DISCUSSION_LIVE_MODEL_CHOICES = [
  { value: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live Extended Thinking — المناقشة / الدفاع' },
  { value: 'gemini-3.8-live', label: 'Gemini 3.8 Live — احتياطي للمناقشة' },
  { value: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview — توافق قديم' },
]

const GEMINI_THINKING_CHOICES = [
  { value: 'high', label: 'High — تفكير أعمق للمناقشة' },
  { value: 'medium', label: 'Medium — توازن' },
  { value: 'low', label: 'Low — سرعة أعلى' },
]

const TEXT_PROVIDER_CHOICES = [
  { value: 'GEMINI', label: 'Gemini Router — مفاتيح Gemini متعددة للنصوص' },
  { value: 'AUTO', label: 'تلقائي — Router بين كل المزودين المتاحين' },
  { value: 'OPENAI', label: 'OpenAI / ChatGPT للنصوص' },
  { value: 'ANTHROPIC', label: 'Claude للنصوص' },
  { value: 'ZAI', label: 'GLM / Z.AI للنصوص' },
  { value: 'GROQ', label: 'Groq — سريع للنماذج المفتوحة' },
  { value: 'OPENROUTER', label: 'OpenRouter — بوابة نماذج متعددة' },
  { value: 'DEEPINFRA', label: 'DeepInfra — نماذج مفتوحة' },
  { value: 'TOGETHER', label: 'Together AI — نماذج مفتوحة' },
  { value: 'UNOROUTER', label: 'UnoRouter — خط احتياطي أخير' },
  { value: 'RELAYROUTER', label: 'RelayRouter — بوابة نماذج متعددة مدفوعة' },
  { value: 'OPENAI_COMPAT', label: 'OpenAI-compatible Gateway — Relay/LiteLLM/خاص' },
]

const ROUTER_POLICY_CHOICES = [
  { value: 'primary_first', label: 'Primary First — يبدأ بالمزود المختار ثم الاحتياطات' },
  { value: 'balanced', label: 'Balanced — تدوير بسيط بين المزودين' },
  { value: 'quality_first', label: 'Quality First — Claude/OpenAI ثم البقية' },
  { value: 'cost_saver', label: 'Cost Saver — Groq/GLM/Gateways أولاً' },
  { value: 'fallback_only', label: 'Fallback Only — المزود المختار فقط' },
]

const OPENAI_TEXT_MODEL_CHOICES = [
  { value: 'gpt-5.1', label: 'GPT-5.1 — تحليل وتوليد قوي' },
  { value: 'gpt-5', label: 'GPT-5 — احتياطي قوي' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini — أسرع وأوفر' },
]

const ANTHROPIC_TEXT_MODEL_CHOICES = [
  { value: 'claude-opus-5', label: 'Claude Opus 5 — أعلى خيار عند توفره في حسابك' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 — قوي للتحليل والكتابة' },
  { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1 — احتياطي قوي' },
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 — احتياطي' },
  { value: 'claude-3-7-sonnet-20250219', label: 'Claude Sonnet 3.7 — احتياطي' },
]

const ZAI_TEXT_MODEL_CHOICES = [
  { value: 'glm-4.5', label: 'GLM-4.5 — أقوى نموذج GLM عام' },
  { value: 'glm-4.5-air', label: 'GLM-4.5 Air — أسرع وأوفر' },
  { value: 'glm-4.5-x', label: 'GLM-4.5 X — أداء أعلى عند توفره' },
  { value: 'glm-4.5-airx', label: 'GLM-4.5 AirX — سريع عند توفره' },
]

const GEMINI_TEXT_ROUTER_MODEL_CHOICES = [
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — افتراضي للنصوص' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — احتياطي' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash — احتياطي قديم' },
]

const GROQ_TEXT_MODEL_CHOICES = [
  { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile — جودة أفضل' },
  { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant — أسرع' },
]

const OPENROUTER_TEXT_MODEL_CHOICES = [
  { value: 'openrouter/auto', label: 'OpenRouter Auto — يختار المتاح' },
  { value: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama مجاني عند توفره' },
]

const OPEN_MODEL_GATEWAY_CHOICES = [
  { value: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B Instruct' },
  { value: 'meta-llama/Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B Instruct' },
]

const UNOROUTER_TEXT_MODEL_CHOICES = [
  { value: 'gpt-5.6-sol:free', label: 'gpt-5.6-sol:free — مجاني' },
  { value: 'gpt-5.4:free', label: 'gpt-5.4:free — مجاني' },
  { value: 'gpt-5.2:free', label: 'gpt-5.2:free — مجاني' },
  { value: 'gpt-oss-120b:free', label: 'gpt-oss-120b:free — مجاني' },
  { value: 'gpt-oss-120b-turbo:free', label: 'gpt-oss-120b-turbo:free — مجاني' },
  { value: 'gpt-oss-20b:free', label: 'gpt-oss-20b:free — مجاني' },
  { value: 'gpt-oss-20b-turbo:free', label: 'gpt-oss-20b-turbo:free — مجاني' },
  { value: 'glm-5.3-search:free', label: 'glm-5.3-search:free — مجاني' },
  { value: 'glm-5.3-flash-search:free', label: 'glm-5.3-flash-search:free — مجاني' },
  { value: 'glm-5.3-flash-think-search:free', label: 'glm-5.3-flash-think-search:free — مجاني' },
  { value: 'glm-5.1-thinking:free', label: 'glm-5.1-thinking:free — مجاني' },
  { value: 'glm-5.1:free', label: 'glm-5.1:free — مجاني' },
  { value: 'gemini-3.8-flash-free:free', label: 'gemini-3.8-flash-free:free — مجاني' },
  { value: 'gemini-3.7-flash-free:free', label: 'gemini-3.7-flash-free:free — مجاني' },
  { value: 'nemotron-3-super-120b-a12b:free', label: 'nemotron-3-super-120b-a12b:free — مجاني' },
  { value: 'llama-4-maverick-17b-128e-instruct:free', label: 'llama-4-maverick-17b-128e-instruct:free — مجاني' },
  { value: 'llama-4-scout:free', label: 'llama-4-scout:free — مجاني' },
  { value: 'llama-3.1-8b:free', label: 'llama-3.1-8b:free — مجاني' },
  { value: 'minimax-m2.5:free', label: 'minimax-m2.5:free — مجاني' },
  { value: 'deepseek/deepseek-v3.2:free', label: 'deepseek/deepseek-v3.2:free — مجاني' },
  { value: 'deepseek/deepseek-chat:free', label: 'DeepSeek Chat Free — مجاني' },
  { value: 'mistral-medium-3.5:free', label: 'mistral-medium-3.5:free — مجاني' },
  { value: 'allam-2-7b:free', label: 'allam-2-7b:free — مجاني' },
  { value: 'bielik-11b-v3.0-instruct:free', label: 'bielik-11b-v3.0-instruct:free — مجاني' },
  { value: 'muse-glimmer-30b:free', label: 'muse-glimmer-30b:free — مجاني' },
  { value: 'ox-alpha:free', label: 'ox-alpha:free — مجاني' },
  { value: 'ling-3.0-flash-fin:free', label: 'ling-3.0-flash-fin:free — مجاني' },
]

const RELAYROUTER_TEXT_MODEL_CHOICES = [
  { value: 'relayrouter/auto', label: 'RelayRouter Auto — يختار النموذج المناسب' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 عبر RelayRouter' },
  { value: 'gpt-5.5', label: 'GPT-5.5 عبر RelayRouter' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash عبر RelayRouter' },
]

const GEMINI_VOICE_CHOICES = [
  'Charon', 'Aoede', 'Puck', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr', 'Achernar', 'Algenib', 'Callirrhoe', 'Despina', 'Erinome', 'Gacrux', 'Iapetus', 'Laomedeia', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zubenelgenubi'
]

// تبويب «النظام: البريد والدفع» في لوحة الإدارة — مركز واحد لكل تكاملات المنصة الخارجية
export function AdminSystemTab() {
  const { toast } = useToast()
  const [data, setData] = useState<SystemData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [textModelCatalog, setTextModelCatalog] = useState<Record<string, { models: string[]; message: string; discoveredCount: number; staticCount: number }>>({})
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [lastBackup, setLastBackup] = useState<BackupRunResult | null>(null)

  const load = () => {
    setLoading(true)
    Promise.all([
      api<SystemData>('/api/admin/system'),
      api<BackupStatus>('/api/admin/backups').catch(() => null),
    ])
      .then(([d, backups]) => {
        setData(d)
        setForm(d.values)
        if (backups) setBackupStatus(backups)
      })
      .catch((e) => toast({ title: 'خطأ', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeTextProviderForModels = form.AI_TEXT_PROVIDER || data?.textAi?.selectedProvider || 'GEMINI'

  useEffect(() => {
    if (!data || !activeTextProviderForModels || textModelCatalog[activeTextProviderForModels]) return
    let cancelled = false
    api<{ ok: boolean; provider: string; models: string[]; message: string; discoveredCount: number; staticCount: number }>('/api/admin/system', {
      method: 'POST',
      body: JSON.stringify({ action: 'text-ai-models', provider: activeTextProviderForModels }),
    })
      .then((r) => {
        if (cancelled || !r?.provider) return
        setTextModelCatalog((prev) => ({
          ...prev,
          [r.provider]: { models: r.models || [], message: r.message || '', discoveredCount: r.discoveredCount || 0, staticCount: r.staticCount || 0 },
        }))
      })
      .catch(() => null)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, activeTextProviderForModels])

  const set = (k: string, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      const d = await api<{ ok: boolean; values: Record<string, string>; gemini?: SystemData['gemini']; textAi?: SystemData['textAi']; agent?: SystemData['agent'] }>('/api/admin/system', {
        method: 'PATCH',
        body: JSON.stringify(form),
      })
      toast({ title: 'تم الحفظ', description: 'تم تطبيق الإعدادات. الحقول السرية لا تتغير إلا إذا كتبت قيمة جديدة فيها.', variant: 'default' as any })
      setData((prev) => (prev ? { ...prev, values: d.values, gemini: d.gemini || prev.gemini, textAi: d.textAi || prev.textAi, agent: d.agent || prev.agent } : prev))
      setForm(d.values)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const testEmail = async () => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; message: string }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({ action: 'test-email' }),
      })
      toast({ title: d.ok ? 'تم الإرسال' : 'تنبيه', description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  const testLocalAgent = async () => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; title?: string; message: string; agent?: SystemData['agent'] }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({ action: 'test-local-agent' }),
      })
      if (d.agent) setData((prev) => (prev ? { ...prev, agent: d.agent } : prev))
      toast({ title: d.title || (d.ok ? 'الوكيل يعمل' : 'فشل الوكيل'), description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  const testGeminiText = async () => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; title?: string; message: string; gemini?: SystemData['gemini'] }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({ action: 'test-gemini-text' }),
      })
      if (d.gemini) setData((prev) => (prev ? { ...prev, gemini: d.gemini } : prev))
      toast({ title: d.title || (d.ok ? 'Gemini يعمل' : 'فشل Gemini'), description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  const testTextAi = async () => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; title?: string; message: string; textAi?: SystemData['textAi'] }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({ action: 'test-text-ai' }),
      })
      if (d.textAi) setData((prev) => (prev ? { ...prev, textAi: d.textAi } : prev))
      toast({ title: d.title || (d.ok ? 'مزود النصوص يعمل' : 'فشل مزود النصوص'), description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  const testGeminiLive = async (purpose: 'SUPERVISOR' | 'DISCUSSION' = 'SUPERVISOR') => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; title?: string; message: string }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({
          action: 'test-gemini-live',
          purpose,
          model: purpose === 'DISCUSSION' ? form.GEMINI_DISCUSSION_LIVE_MODEL : form.GEMINI_SUPERVISOR_LIVE_MODEL,
          voice: form.GEMINI_TTS_VOICE,
        }),
      })
      toast({ title: d.title || (d.ok ? 'Gemini Live يعمل' : 'فشل Gemini Live'), description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
      </div>
    )
  }
  if (!data) return null

  const statusBadge = (s: string) => {
    if (s === 'SENT') return { cls: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 className="h-3 w-3" />, label: 'أُرسل' }
    if (s === 'FAILED') return { cls: 'bg-red-100 text-red-600', icon: <XCircle className="h-3 w-3" />, label: 'فشل' }
    return { cls: 'bg-amber-100 text-amber-700', icon: <Clock3 className="h-3 w-3" />, label: 'تخطى (لا بريد)' }
  }

  const F = (k: string, label: string, placeholder = '', type = 'text', hint = '') => (
    <div key={k} className="space-y-1">
      <Label className="text-[11px] font-black text-[#0f2b46]">{label}</Label>
      <Input
        type={type}
        value={form[k] ?? ''}
        onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder}
        dir={type === 'password' || k.includes('KEY') || k.includes('SECRET') || k.includes('PASS') ? 'ltr' : undefined}
        className="h-9 bg-white text-sm"
      />
      {hint && <p className="text-[10px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  )

  const SelectF = (k: string, label: string, options: { value: string; label: string }[], hint = '') => {
    const current = form[k] || options[0]?.value || ''
    const normalizedOptions = current && !options.some((o) => o.value === current)
      ? [{ value: current, label: `${current} — محفوظ سابقاً` }, ...options]
      : options
    return (
      <div key={k} className="space-y-1">
        <Label className="text-[11px] font-black text-[#0f2b46]">{label}</Label>
        <Select value={current} onValueChange={(v) => set(k, v)}>
          <SelectTrigger className="h-9 bg-white text-sm" dir="ltr">
            <SelectValue placeholder="اختر" />
          </SelectTrigger>
          <SelectContent>
            {normalizedOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} dir="ltr">{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hint && <p className="text-[10px] leading-relaxed text-slate-400">{hint}</p>}
      </div>
    )
  }

  const modelOptions = (provider: string, fallback: { value: string; label: string }[]) => {
    const catalog = textModelCatalog[provider]
    const dynamic = (catalog?.models || []).map((model) => ({
      value: model,
      label: `${model}${catalog?.discoveredCount ? ' — مكتشف تلقائياً' : ''}`,
    }))
    const seen = new Set<string>()
    return [...dynamic, ...fallback].filter((opt) => {
      if (!opt.value || seen.has(opt.value)) return false
      seen.add(opt.value)
      return true
    })
  }

  const modelHint = (provider: string, fallback = '') => {
    const catalog = textModelCatalog[provider]
    return catalog?.message ? `${catalog.message}${fallback ? ` — ${fallback}` : ''}` : fallback
  }

  const geminiDiag = data.gemini
  const geminiSourceLabel = geminiDiag?.source === 'db'
    ? 'مفتاح لوحة الإدارة'
    : geminiDiag?.source === 'env'
      ? 'مفتاح Vercel الافتراضي'
      : 'لا يوجد مفتاح فعّال'
  const textAiDiag = data.textAi
  const currentTextProvider = (form.AI_TEXT_PROVIDER || textAiDiag?.selectedProvider || 'GEMINI') as 'GEMINI' | 'OPENAI' | 'ANTHROPIC' | 'ZAI' | 'GROQ' | 'OPENROUTER' | 'DEEPINFRA' | 'TOGETHER' | 'UNOROUTER' | 'RELAYROUTER' | 'OPENAI_COMPAT' | 'AUTO'
  const agentDiag = data.agent
  const agentSourceLabel = agentDiag?.source === 'settings'
    ? 'إعدادات لوحة الإدارة'
    : agentDiag?.source === 'env'
      ? 'متغيرات السيرفر/Vercel'
      : 'غير مضبوط'
  const currentPaymentMode = (form.PAYMENT_MODE || data.paymentMode || 'SANDBOX') as 'SANDBOX' | 'LIVE'

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-600">
        <ShieldCheck className="ml-1 inline h-4 w-4 text-[#a8841a]" />
        إدارة الأسرار: القيم المقنّعة مثل •••••• محفوظة ولا تتغير عند الحفظ. لتغيير أي سر اكتب قيمة جديدة، ولا تُرسل مفاتيح Stripe/Gemini/Resend خارج لوحة الإدارة أو Vercel.
      </div>
      <Tabs defaultValue="mail" dir="rtl">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-xl bg-[#f1f5f9] p-1 sm:grid-cols-6">
          <TabsTrigger value="mail" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Mail className="h-3.5 w-3.5" /> الإشعارات البريدية
          </TabsTrigger>
          <TabsTrigger value="pay" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <CreditCard className="h-3.5 w-3.5" /> بوابات الدفع
          </TabsTrigger>
          <TabsTrigger value="gemini" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Bot className="h-3.5 w-3.5" /> Gemini / AI
          </TabsTrigger>
          <TabsTrigger value="launch" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <ShieldCheck className="h-3.5 w-3.5" /> جاهزية الإطلاق
          </TabsTrigger>
          <TabsTrigger value="agent" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Bot className="h-3.5 w-3.5" /> الوكيل المفتوح
          </TabsTrigger>
          <TabsTrigger value="turn" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Network className="h-3.5 w-3.5" /> TURN للفيديو
          </TabsTrigger>
        </TabsList>

        {/* ===== الإشعارات البريدية ===== */}
        <TabsContent value="mail" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold text-slate-600">
            <Info className="h-4 w-4 text-[#a8841a]" />
            اضبط Resend كخيار أساسي للإشعارات، أو SMTP كبديل. سترسل المنصة إشعارات التسجيل، طلبات الالتحاق، الإيصالات، قرارات القبول، الامتحانات، مواعيد المناقشات، والشهادات.
          </div>
          <div className="grid gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[11px] font-black text-emerald-800">Resend — الإرسال الموصى به للإنتاج</h4>
              <Badge className={data.resendConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                {data.resendConfigured ? 'Resend مضبوط' : 'Resend غير مضبوط'}
              </Badge>
            </div>
            {F('RESEND_API_KEY', 'Resend API Key', data.secretsSet.RESEND_API_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 're_...', 'password', 'يفضّل حفظه في Vercel أو هنا. لن يظهر للمتصفح.')}
            {F('MAIL_FROM', 'عنوان المرسل MAIL_FROM', 'AACT <notifications@your-domain.com>', 'text', 'يجب أن يكون من نطاق موثق داخل Resend.')}
            {F('RESEND_FROM', 'عنوان Resend بديل RESEND_FROM', 'notifications@your-domain.com', 'text', 'اختياري؛ يستخدم إذا لم تضبط MAIL_FROM.')}
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            {F('SMTP_HOST', 'خادم SMTP', 'smtp.gmail.com', 'text', 'مثال: smtp.gmail.com أو mail.aact.academy')}
            {F('SMTP_PORT', 'المنفذ', '587', 'text', '587 مع TLS أو 465 مع SSL')}
            {F('SMTP_USER', 'اسم المستخدم (البريد)', 'notifications@aact.academy')}
            {F('SMTP_PASS', 'كلمة المرور / كلمة تطبيق', data.secretsSet.SMTP_PASS ? 'محفوظة — اكتب جديدة للتغيير' : 'app-password', 'password')}
            {F('SMTP_FROM', 'البريد المرسل From', 'notifications@aact.academy')}
            {F('SMTP_NAME', 'اسم المرسل المعروض', 'الأكاديمية الأمريكية للاستشارات والتدريب')}
            <div className="flex items-center justify-between rounded-xl border border-[#0f2b46]/10 bg-white px-4 py-3 sm:col-span-2">
              <div>
                <p className="text-xs font-black text-[#0f2b46]">تفعيل الإرسال الفعلي</p>
                <p className="text-[10px] text-slate-500">خاص بـ SMTP فقط. إذا كان SMTP معطلاً يمكن أن يرسل Resend عند ضبط مفتاحه وعنوان المرسل.</p>
              </div>
              <div className="flex items-center gap-2">
                <input type="hidden" value={form.SMTP_ENABLED ?? ''} />
                <Switch
                  checked={form.SMTP_ENABLED === '1'}
                  onCheckedChange={(v) => set('SMTP_ENABLED', v ? '1' : '0')}
                />
                <Badge className={data.smtpEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}>
                  {data.smtpEnabled ? 'يعمل الآن' : 'غير مهيأ'}
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات البريد
            </Button>
            <Button onClick={testEmail} disabled={testing} variant="outline" className="border-[#c9a227] font-extrabold text-[#a8841a] hover:bg-[#f7edd0]">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <SendHorizonal className="ml-2 h-4 w-4" />} إرسال رسالة تجريبية لبريدي
            </Button>
          </div>

          {/* سجل البريد */}
          <div className="overflow-hidden rounded-2xl border border-[#0f2b46]/10 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h4 className="text-xs font-black text-[#0f2b46]">سجل الإشعارات البريدية (آخر 50)</h4>
            </div>
            <div className="aact-scroll max-h-72 overflow-y-auto">
              {data.emails.length === 0 ? (
                <p className="p-6 text-center text-xs font-bold text-slate-400">لا رسائل بعد — ستظهر هنا فور حدوث الأحداث</p>
              ) : (
                data.emails.map((e) => {
                  const b = statusBadge(e.status)
                  return (
                    <div key={e.id} className="flex items-start justify-between gap-3 border-b border-slate-50 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-black text-[#0f2b46]">{e.subject}</p>
                        <p dir="ltr" className="truncate text-right text-[10px] text-slate-400">{e.to} · {e.event}</p>
                        {e.error && <p className="mt-0.5 truncate text-[9px] text-red-400">{e.error}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[9px] text-slate-300">{new Date(e.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        <Badge className={`gap-1 text-[9px] ${b.cls}`}>{b.icon} {b.label}</Badge>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </TabsContent>

        {/* ===== بوابات الدفع ===== */}
        <TabsContent value="pay" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-600">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            أدخل مفاتيح مزودي الدفع الفعليين وشغّل وضع LIVE. لوحة التنبيهات أدناه تكشف مفاتيح Stripe التجريبية، PayPal sandbox، غياب Webhook، وحالة كل طريقة دفع قبل ظهورها للطالب.
          </div>
          {data.payment && (
            <div className="space-y-3">
              <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 sm:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                  <p className="text-[10px] font-bold text-slate-500">الوضع الفعلي</p>
                  <p className={data.payment.mode === 'LIVE' ? 'mt-1 font-black text-emerald-700' : 'mt-1 font-black text-amber-700'}>{data.payment.mode}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                  <p className="text-[10px] font-bold text-slate-500">Stripe Key</p>
                  <p className={data.payment.stripeKeyKind === 'live' ? 'mt-1 font-black text-emerald-700' : data.payment.stripeKeyKind === 'test' ? 'mt-1 font-black text-red-600' : 'mt-1 font-black text-slate-400'}>{data.payment.stripeKeyKind}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                  <p className="text-[10px] font-bold text-slate-500">PayPal Base</p>
                  <p className={data.payment.paypalBaseKind === 'live' ? 'mt-1 font-black text-emerald-700' : data.payment.paypalBaseKind === 'sandbox' ? 'mt-1 font-black text-red-600' : 'mt-1 font-black text-slate-400'}>{data.payment.paypalBaseKind}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                  <p className="text-[10px] font-bold text-slate-500">بوابات حقيقية فعالة</p>
                  <p className={data.payment.trueGatewayCount > 0 ? 'mt-1 font-black text-emerald-700' : 'mt-1 font-black text-red-600'}>{data.payment.trueGatewayCount}</p>
                </div>
              </div>
              {(data.payment.errors || []).map((msg) => (
                <div key={msg} className="rounded-xl border border-red-100 bg-red-50 p-3 text-[11px] font-bold leading-relaxed text-red-700">{msg}</div>
              ))}
              {(data.payment.warnings || []).map((msg) => (
                <div key={msg} className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] font-bold leading-relaxed text-amber-700">{msg}</div>
              ))}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(data.payment.methods || []).map((m) => (
                  <div key={m.id} className={`rounded-xl border p-3 text-[11px] font-bold ${m.enabled ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-slate-100 bg-slate-50 text-slate-500'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{m.label}</span>
                      <Badge className={m.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}>{m.enabled ? 'مفعلة' : 'مقفلة'}</Badge>
                    </div>
                    {!m.enabled && m.reason && <p className="mt-2 leading-relaxed text-slate-500">{m.reason}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-xl border border-[#0f2b46]/10 bg-white px-4 py-3 sm:col-span-2">
              <div>
                <p className="text-xs font-black text-[#0f2b46]">وضع الدفع العام</p>
                <p className="text-[10px] leading-relaxed text-slate-500">
                  SANDBOX = محاكاة داخل المنصة (للتجربة) · LIVE = دفع حقيقي عبر المزودين المفعّلين
                </p>
              </div>
              <div className="flex overflow-hidden rounded-lg border border-[#0f2b46]/15">
                {['SANDBOX', 'LIVE'].map((m) => (
                  <button
                    key={m}
                    onClick={() => set('PAYMENT_MODE', m)}
                    className={`px-4 py-2 text-[11px] font-black transition-colors ${currentPaymentMode === m ? 'bg-[#0f2b46] text-[#e0b83a]' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]">
                <CreditCard className="h-3.5 w-3.5" /> Stripe (بطاقات دولية)
              </h4>
            </div>
            {F('STRIPE_SECRET_KEY', 'Secret Key', data.secretsSet.STRIPE_SECRET_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'sk_live_...', 'password', 'من لوحة Stripe → Developers → API keys')}
            {F('STRIPE_WEBHOOK_SECRET', 'Webhook Signing Secret', data.secretsSet.STRIPE_WEBHOOK_SECRET ? 'محفوظ — اكتب جديداً للتغيير' : 'whsec_...', 'password', 'أنشئ Webhook يشير إلى: /api/payments/webhook/stripe (حدث checkout.session.completed)')}
            <div className="sm:col-span-2">
              <h4 className="mb-2 mt-1 flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]">
                <CreditCard className="h-3.5 w-3.5" /> PayPal
              </h4>
            </div>
            {F('PAYPAL_CLIENT_ID', 'Client ID', '', 'text', 'من developer.paypal.com → تطبيقك')}
            {F('PAYPAL_SECRET', 'Client Secret', data.secretsSet.PAYPAL_SECRET ? 'محفوظ — اكتب جديداً للتغيير' : '', 'password')}
            {F('PAYPAL_API_BASE', 'API Base', 'https://api-m.paypal.com', 'text', 'حقيقي: api-m.paypal.com — اختبار فقط: api-m.sandbox.paypal.com')}
            <div className="sm:col-span-2">
              <h4 className="mb-2 mt-1 flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]">
                <CreditCard className="h-3.5 w-3.5" /> USDT — دفع يدوي بتأكيد الإدارة
              </h4>
            </div>
            {F('USDT_WALLET_ADDRESS', 'عنوان محفظة USDT', 'مثال: T... أو 0x...', 'text', 'يظهر للطالب عند اختيار USDT، ولا يتم اعتماد السداد حتى تؤكده الإدارة.')}
            {SelectF('USDT_NETWORK', 'الشبكة', [
              { value: 'TRC20', label: 'TRC20 — تحقق آلي عبر TronGrid' },
              { value: 'BEP20', label: 'BEP20 — مراجعة إدارية عبر TxID' },
              { value: 'ERC20', label: 'ERC20 — مراجعة إدارية عبر TxID' },
            ], 'التحقق الآلي مفعّل حالياً لشبكة TRC20 فقط. BEP20/ERC20 تُقبل بـ TxID وتحتاج اعتماداً إدارياً بعد المراجعة.')}
            {F('USDT_PAYMENT_INSTRUCTIONS', 'تعليمات إضافية', 'أرسل TxID بعد التحويل ولا تعتمد الدفعة قبل تأكيد الإدارة', 'text', 'اختياري: تعليمات تظهر ضمن رسالة الدفع للطالب.')}
          </div>
          <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
            {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات الدفع
          </Button>
          <div className="rounded-xl bg-[#f7edd0]/60 p-3 text-[10px] font-bold leading-relaxed text-[#5c4d1a]">
            <p className="mb-1 font-black">حالة الوضع الحالي: {data.paymentMode === 'LIVE' ? 'LIVE — دفع حقيقي عبر المزودين المفعّلين' : 'SANDBOX — محاكاة / غير إنتاجي'}</p>
            ملاحظة: في الإنتاج لا تعمل SANDBOX تلقائياً. إذا لم تضبط Stripe live أو PayPal live ستظهر طرق الدفع للطالب كمقفلة مع رسالة توضيحية بدلاً من إنشاء إيصال تجريبي.
          </div>
        </TabsContent>

        {/* ===== Gemini / AI ===== */}
        <TabsContent value="gemini" className="mt-4 space-y-4">
          <div className="grid gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] font-bold leading-relaxed text-emerald-800 sm:grid-cols-3">
            <div><Bot className="ml-1 inline h-4 w-4" /> نموذج النصوص: الامتحانات، التصحيح، المشرف الذكي، تحليل القبول، والبحث.</div>
            <div><Radio className="ml-1 inline h-4 w-4" /> Gemini Live: محادثة صوتية حية عبر WebSocket، وليس مجرد Text→TTS.</div>
            <div><Info className="ml-1 inline h-4 w-4" /> يمكن الآن اختيار مزود نصوص خارجي للامتحانات والتحليل، مع بقاء Gemini Live منفصلاً للصوت.</div>
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-4 text-xs font-bold text-[#0f2b46] sm:grid-cols-3">
            <div className="rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
              <p className="text-[10px] text-slate-500">المفتاح المستخدم الآن</p>
              <p className="mt-1 font-black text-[#a8841a]">{geminiSourceLabel}</p>
              {geminiDiag?.activeMask && <p className="mt-1 font-mono text-[10px] text-slate-400" dir="ltr">{geminiDiag.activeMask}</p>}
            </div>
            <div className="rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
              <p className="text-[10px] text-slate-500">مفتاح لوحة الإدارة</p>
              <p className={geminiDiag?.adminKeySet ? 'mt-1 font-black text-emerald-700' : 'mt-1 font-black text-slate-400'}>{geminiDiag?.adminKeySet ? 'موجود وله الأولوية' : 'غير موجود'}</p>
            </div>
            <div className="rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
              <p className="text-[10px] text-slate-500">مفتاح Vercel الافتراضي</p>
              <p className={geminiDiag?.envKeySet ? 'mt-1 font-black text-emerald-700' : 'mt-1 font-black text-slate-400'}>{geminiDiag?.envKeySet ? 'موجود كاحتياطي' : 'غير موجود'}</p>
            </div>
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]"><Bot className="h-3.5 w-3.5" /> Gemini الأساسي والصوت الحي</h4>
            </div>
            {F('GEMINI_API_KEY', 'مفتاح Gemini API', data.secretsSet.GEMINI_API_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'AIza...', 'password', 'يبقى في السيرفر ولا يظهر في المتصفح')}
            {F('GEMINI_TEXT_MODEL', 'نموذج Gemini للنصوص / احتياطي', 'gemini-3.8-flash', 'text', 'يستخدم عند اختيار Gemini أو عند فشل مزود النصوص الخارجي. لا تضع نموذج Live هنا.')}
            {F('GEMINI_TTS_MODEL', 'نموذج TTS', 'gemini-3.1-flash-tts-preview', 'text', 'للردود الصوتية غير Live فقط')}
            {SelectF('GEMINI_TTS_VOICE', 'صوت Gemini Live / TTS', GEMINI_VOICE_CHOICES.map((v) => ({ value: v, label: v })), 'اختر الصوت من القائمة بدلاً من كتابته يدوياً.')}
            {SelectF('GEMINI_SUPERVISOR_LIVE_MODEL', 'Live للمشرف الذكي', GEMINI_SUPERVISOR_LIVE_MODEL_CHOICES, 'الموصى به: gemini-3.8-live للمشرف اليومي منخفض التأخير.')}
            {SelectF('GEMINI_DISCUSSION_LIVE_MODEL', 'Live للمناقشة / الدفاع', GEMINI_DISCUSSION_LIVE_MODEL_CHOICES, 'الموصى به: gemini-3.8-live-extended-thinking للمناقشات والدفاع الأكاديمي.')}
            {SelectF('GEMINI_DISCUSSION_THINKING_LEVEL', 'مستوى التفكير للمناقشة', GEMINI_THINKING_CHOICES, 'يطبق على Live الحديث عند دعم النموذج.')}
          </div>

          <div className="grid gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-[11px] font-black text-indigo-900">مزود النصوص الخارجي — للامتحانات والتحليل والتصحيح والقراءة النصية</h4>
                <p className="mt-1 text-[10px] font-bold leading-relaxed text-indigo-700">هذا القسم لا يغير الصوت ولا Gemini Live. عند ضبطه ستستخدم وظائف النصوص المزود المختار، ويبقى Gemini احتياطياً عند توفر مفتاحه.</p>
              </div>
              <Badge className={textAiDiag?.externalConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}>{textAiDiag?.externalConfigured ? `نشط: ${textAiDiag.activeProvider}` : 'Gemini / غير خارجي'}</Badge>
            </div>
            {SelectF('AI_TEXT_PROVIDER', 'مزود النصوص', TEXT_PROVIDER_CHOICES, 'اختر GEMINI لاستخدام مفاتيح Gemini في Router، أو AUTO للتنقل بين كل المزودات.')}
            {SelectF('AI_ROUTER_POLICY', 'سياسة التوجيه', ROUTER_POLICY_CHOICES, 'primary_first هو الأكثر وضوحاً. cost_saver يبدأ بالمزودات الأرخص/المفتوحة.')}
            <div className="flex items-center justify-between rounded-xl border border-indigo-100 bg-white px-4 py-3 sm:col-span-2">
              <div>
                <p className="text-xs font-black text-indigo-900">السماح بالبوابات العامة كاحتياط</p>
                <p className="text-[10px] leading-relaxed text-indigo-700">OpenRouter/DeepInfra/Together/UnoRouter/OpenAI-compatible تُستخدم في AUTO فقط عند تفعيل هذا الخيار، أو عند اختيارها كمزود مباشر.</p>
              </div>
              <Switch checked={form.AI_ROUTER_ALLOW_PUBLIC_GATEWAYS === '1'} onCheckedChange={(v) => set('AI_ROUTER_ALLOW_PUBLIC_GATEWAYS', v ? '1' : '0')} />
            </div>
            <div className="rounded-xl bg-white p-3 text-[10px] font-bold leading-relaxed text-indigo-700 ring-1 ring-indigo-100">
              {textAiDiag?.message || 'لم يتم تحميل تشخيص مزود النصوص بعد.'}
              {textAiDiag?.lastResult && (
                <p className={textAiDiag.lastResult.ok ? 'mt-1 text-emerald-700' : 'mt-1 text-red-600'}>
                  آخر محاولة: {textAiDiag.lastResult.provider}/{textAiDiag.lastResult.model} — {textAiDiag.lastResult.ok ? 'نجحت' : textAiDiag.lastResult.error}
                </p>
              )}
            </div>
            {textAiDiag?.keyCounts && (
              <div className="grid gap-2 rounded-xl bg-white p-3 text-[10px] font-bold text-slate-600 ring-1 ring-indigo-100 sm:col-span-2 sm:grid-cols-5">
                {Object.entries(textAiDiag.keyCounts).map(([provider, count]) => (
                  <div key={provider} className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1">
                    <span>{provider}</span><Badge className={count ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}>{count}</Badge>
                  </div>
                ))}
              </div>
            )}
            {!!textAiDiag?.cooldowns?.length && (
              <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[10px] font-bold leading-relaxed text-amber-700 sm:col-span-2">
                مفاتيح في cooldown: {textAiDiag.cooldowns.map((c) => `${c.provider}/${c.key} حتى ${new Date(c.until).toLocaleTimeString('ar')}`).join('، ')}
              </div>
            )}
            {currentTextProvider === 'GEMINI' || currentTextProvider === 'AUTO' ? (
              <>
                {F('GEMINI_API_KEYS', 'مفاتيح Gemini للنصوص — متعددة', data.secretsSet.GEMINI_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'key1,key2,key3', 'password', 'اكتب أكثر من مفتاح مفصولاً بفاصلة. الحصص غالباً على مستوى المشروع، لكن هذا يفيد عند وجود مشاريع/مفاتيح مستقلة.')}
                {SelectF('GEMINI_TEXT_MODEL', 'نموذج Gemini داخل Router', modelOptions('GEMINI', GEMINI_TEXT_ROUTER_MODEL_CHOICES), modelHint('GEMINI', 'يستخدم للنصوص فقط، وليس Gemini Live.'))}
              </>
            ) : null}
            {currentTextProvider === 'OPENAI' || currentTextProvider === 'AUTO' ? (
              <>
                {F('OPENAI_API_KEY', 'OpenAI API Key', data.secretsSet.OPENAI_API_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'sk-...', 'password', 'يستخدم لنماذج ChatGPT / OpenAI النصية فقط.')}
                {F('OPENAI_API_KEYS', 'OpenAI API Keys متعددة', data.secretsSet.OPENAI_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'sk-...,sk-...', 'password', 'اختياري: مفاتيح متعددة مفصولة بفاصلة للـ failover.')}
                {SelectF('OPENAI_TEXT_MODEL', 'نموذج OpenAI للنصوص', modelOptions('OPENAI', OPENAI_TEXT_MODEL_CHOICES), modelHint('OPENAI', 'للتوليد والتحليل والأسئلة. يمكن كتابة نموذج محفوظ سابقاً أيضاً.'))}
                {F('OPENAI_BASE_URL', 'OpenAI Base URL اختياري', 'https://api.openai.com/v1', 'text', 'اتركه افتراضياً إلا إذا كنت تستخدم بوابة متوافقة.')}
              </>
            ) : null}
            {currentTextProvider === 'ANTHROPIC' || currentTextProvider === 'AUTO' ? (
              <>
                {F('ANTHROPIC_API_KEY', 'Anthropic API Key', data.secretsSet.ANTHROPIC_API_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'sk-ant-...', 'password', 'يستخدم Claude للنصوص والتحليل.')}
                {F('ANTHROPIC_API_KEYS', 'Anthropic API Keys متعددة', data.secretsSet.ANTHROPIC_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'sk-ant-...,sk-ant-...', 'password', 'اختياري: مفاتيح متعددة مفصولة بفاصلة للـ failover.')}
                {SelectF('ANTHROPIC_TEXT_MODEL', 'نموذج Claude للنصوص', modelOptions('ANTHROPIC', ANTHROPIC_TEXT_MODEL_CHOICES), modelHint('ANTHROPIC', 'Sonnet للتحليل المتوازن، Opus للمهام الأثقل عند توفره.'))}
              </>
            ) : null}
            {currentTextProvider === 'ZAI' || currentTextProvider === 'AUTO' ? (
              <>
                {F('ZAI_API_KEY', 'Z.AI / GLM API Key', data.secretsSet.ZAI_API_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'zai-...', 'password', 'يستخدم GLM-4.5 للنصوص والتحليل.')}
                {F('ZAI_API_KEYS', 'Z.AI / GLM API Keys متعددة', data.secretsSet.ZAI_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'key1,key2', 'password', 'اختياري: مفاتيح متعددة مفصولة بفاصلة للـ failover.')}
                {SelectF('ZAI_TEXT_MODEL', 'نموذج GLM للنصوص', modelOptions('ZAI', ZAI_TEXT_MODEL_CHOICES), modelHint('ZAI', 'GLM-4.5 أحدث عائلة GLM قوية للنصوص والاستدلال.'))}
                {F('ZAI_API_BASE', 'Z.AI API Base', 'https://api.z.ai/api/paas/v4', 'text', 'متوافق مع chat/completions.')}
              </>
            ) : null}
            {currentTextProvider === 'GROQ' || currentTextProvider === 'AUTO' ? (
              <>
                {F('GROQ_API_KEYS', 'Groq API Keys', data.secretsSet.GROQ_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'gsk_...,gsk_...', 'password', 'مفاتيح متعددة مفصولة بفاصلة.')}
                {SelectF('GROQ_TEXT_MODEL', 'نموذج Groq', modelOptions('GROQ', GROQ_TEXT_MODEL_CHOICES), modelHint('GROQ', 'مناسب للمسودات السريعة والأسئلة القصيرة.'))}
                {F('GROQ_API_BASE', 'Groq Base URL', 'https://api.groq.com/openai/v1', 'text')}
              </>
            ) : null}
            {currentTextProvider === 'OPENROUTER' || currentTextProvider === 'AUTO' ? (
              <>
                {F('OPENROUTER_API_KEYS', 'OpenRouter API Keys', data.secretsSet.OPENROUTER_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'sk-or-...,sk-or-...', 'password', 'يستخدم فقط عند تفعيل البوابات العامة أو اختياره مباشرة.')}
                {SelectF('OPENROUTER_TEXT_MODEL', 'نموذج OpenRouter', modelOptions('OPENROUTER', OPENROUTER_TEXT_MODEL_CHOICES), modelHint('OPENROUTER', 'openrouter/auto يختار مساراً متاحاً عند المزود.'))}
                {F('OPENROUTER_BASE_URL', 'OpenRouter Base URL', 'https://openrouter.ai/api/v1', 'text')}
              </>
            ) : null}
            {currentTextProvider === 'DEEPINFRA' || currentTextProvider === 'AUTO' ? (
              <>
                {F('DEEPINFRA_API_KEYS', 'DeepInfra API Keys', data.secretsSet.DEEPINFRA_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'key1,key2', 'password')}
                {SelectF('DEEPINFRA_TEXT_MODEL', 'نموذج DeepInfra', modelOptions('DEEPINFRA', OPEN_MODEL_GATEWAY_CHOICES), modelHint('DEEPINFRA', 'نماذج مفتوحة عبر DeepInfra.'))}
                {F('DEEPINFRA_BASE_URL', 'DeepInfra Base URL', 'https://api.deepinfra.com/v1', 'text')}
              </>
            ) : null}
            {currentTextProvider === 'TOGETHER' || currentTextProvider === 'AUTO' ? (
              <>
                {F('TOGETHER_API_KEYS', 'Together API Keys', data.secretsSet.TOGETHER_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'key1,key2', 'password')}
                {SelectF('TOGETHER_TEXT_MODEL', 'نموذج Together', modelOptions('TOGETHER', OPEN_MODEL_GATEWAY_CHOICES), modelHint('TOGETHER', 'نماذج مفتوحة عبر Together.'))}
                {F('TOGETHER_BASE_URL', 'Together Base URL', 'https://api.together.ai/v1', 'text')}
              </>
            ) : null}
            {currentTextProvider === 'UNOROUTER' || currentTextProvider === 'AUTO' ? (
              <>
                {F('UNOROUTER_API_KEYS', 'UnoRouter API Keys', data.secretsSet.UNOROUTER_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'key1,key2', 'password', 'خط دفاع أخير عند توفره.')}
                {SelectF('UNOROUTER_TEXT_MODEL', 'نموذج UnoRouter', modelOptions('UNOROUTER', UNOROUTER_TEXT_MODEL_CHOICES), modelHint('UNOROUTER', 'استخدم النماذج المجانية فقط عندما تكون متاحة في حسابك.'))}
                {F('UNOROUTER_BASE_URL', 'UnoRouter Base URL', 'https://api.unorouter.com/v1', 'text')}
              </>
            ) : null}
            {currentTextProvider === 'RELAYROUTER' || currentTextProvider === 'AUTO' ? (
              <>
                {F('RELAYROUTER_API_KEYS', 'RelayRouter API Keys', data.secretsSet.RELAYROUTER_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'rr_...,rr_...', 'password', 'مفتاح أو أكثر من RelayRouter مفصول بفاصلة.')}
                {SelectF('RELAYROUTER_TEXT_MODEL', 'نموذج RelayRouter', modelOptions('RELAYROUTER', RELAYROUTER_TEXT_MODEL_CHOICES), modelHint('RELAYROUTER', 'يمكنك اختيار auto أو نموذج محدد من لوحة RelayRouter.'))}
                {F('RELAYROUTER_BASE_URL', 'RelayRouter Base URL', 'https://relayrouter.io/v1', 'text')}
              </>
            ) : null}
            {currentTextProvider === 'OPENAI_COMPAT' || currentTextProvider === 'AUTO' ? (
              <>
                {F('OPENAI_COMPAT_API_KEYS', 'OpenAI-compatible API Keys', data.secretsSet.OPENAI_COMPAT_API_KEYS ? 'محفوظة — اكتب قيماً جديدة للتغيير' : 'key1,key2', 'password', 'RelayFreeLLM / LiteLLM / Gateway خاص.')}
                {SelectF('OPENAI_COMPAT_TEXT_MODEL', 'نموذج OpenAI-compatible', modelOptions('OPENAI_COMPAT', [{ value: 'auto', label: 'auto — يختار Gateway النموذج' }]), modelHint('OPENAI_COMPAT', 'إذا عرض Gateway نماذج مجانية عبر /models ستظهر هنا تلقائياً.'))}
                {F('OPENAI_COMPAT_BASE_URL', 'OpenAI-compatible Base URL', 'https://your-gateway.example/v1', 'text', 'يجب أن يدعم /chat/completions.')}
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات Gemini
            </Button>
            <Button onClick={testGeminiText} disabled={testing} variant="outline" className="border-[#c9a227] font-extrabold text-[#a8841a] hover:bg-[#fffaf0]">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Bot className="ml-2 h-4 w-4" />} اختبار Gemini Text
            </Button>
            <Button onClick={testTextAi} disabled={testing} variant="outline" className="border-indigo-300 font-extrabold text-indigo-700 hover:bg-indigo-50">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Bot className="ml-2 h-4 w-4" />} اختبار مزود النصوص الخارجي
            </Button>
            <Button onClick={() => testGeminiLive('SUPERVISOR')} disabled={testing} variant="outline" className="border-emerald-300 font-extrabold text-emerald-700 hover:bg-emerald-50">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Radio className="ml-2 h-4 w-4" />} اختبار Live المشرف
            </Button>
            <Button onClick={() => testGeminiLive('DISCUSSION')} disabled={testing} variant="outline" className="border-emerald-300 font-extrabold text-emerald-700 hover:bg-emerald-50">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Radio className="ml-2 h-4 w-4" />} اختبار Live المناقشة
            </Button>
          </div>
          <div className="rounded-xl bg-[#f7edd0]/60 p-3 text-[10px] font-bold leading-relaxed text-[#5c4d1a]">
            إذا ظهر 429 فالمفتاح سليم لكن الحصة انتهت مؤقتاً. Live الحديث يستخدم للمشرف gemini-3.8-live وللمناقشة gemini-3.8-live-extended-thinking. مزودات OpenAI/Claude/GLM تخص النصوص فقط ولا تغيّر الصوت أو Live.
          </div>
        </TabsContent>

        {/* ===== جاهزية الإطلاق ===== */}
        <TabsContent value="launch" className="mt-4 space-y-4">
          <div className="rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-600">
            <ShieldCheck className="ml-1 inline h-4 w-4 text-emerald-600" />
            هذه اللوحة قراءة وتشخيص فقط: لا تعدّل البيانات ولا ترفع ملفات. هدفها إعطاء الإدارة صورة سريعة قبل الإطلاق.
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline" className="border-emerald-200 font-black text-emerald-700">
                <a href="/api/admin/monitoring" target="_blank" rel="noreferrer">تقرير الأداء والمراقبة JSON</a>
              </Button>
              <Button asChild size="sm" variant="outline" className="border-blue-200 font-black text-blue-700">
                <a href="/api/health" target="_blank" rel="noreferrer">Health Check عام</a>
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(data.launchReadiness || []).map((item) => (
              <div key={item.id} className={`rounded-2xl border p-4 ${item.status === 'ok' ? 'border-emerald-100 bg-emerald-50' : item.status === 'error' ? 'border-red-100 bg-red-50' : 'border-amber-100 bg-amber-50'}`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-xs font-black text-[#0f2b46]">{item.label}</h4>
                  <Badge className={item.status === 'ok' ? 'bg-emerald-100 text-emerald-700' : item.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}>
                    {item.status === 'ok' ? 'جاهز' : item.status === 'error' ? 'خطأ' : 'تنبيه'}
                  </Badge>
                </div>
                <p className="text-[11px] font-bold leading-relaxed text-slate-600">{item.detail}</p>
              </div>
            ))}
          </div>
          {(!data.launchReadiness || data.launchReadiness.length === 0) && (
            <div className="rounded-xl bg-slate-50 p-6 text-center text-xs font-bold text-slate-400">لا توجد بيانات جاهزية حالياً.</div>
          )}
          <div className="rounded-xl bg-[#f7edd0]/60 p-3 text-[10px] font-bold leading-relaxed text-[#5c4d1a]">
            التخزين R2 له تقرير سلامة مستقل موجود في لوحة الإدارة، لذلك لم يتم تكرار فحصه هنا. راجع تقرير سلامة التخزين عند تحديث الكتب أو الملفات الكبيرة.
          </div>
        </TabsContent>

        {/* ===== الوكيل الذكي المفتوح المصدر ===== */}
        <TabsContent value="agent" className="mt-4 space-y-4">
          <div className="rounded-xl border border-[#c9a227]/30 bg-[#fffaf0] p-4 text-[11px] font-bold leading-relaxed text-[#5c4d1a]">
            <Bot className="ml-1 inline h-4 w-4 text-[#a8841a]" />
            هذا هو عقل الوكيل الذكي المتكامل للمنصة. إذا ضبطت نموذجاً مفتوح المصدر محلياً عبر Ollama أو أي OpenAI-compatible endpoint فسيستخدمه الوكيل أولاً، ويظل المشرف الذكي الأكاديمي شخصية داخل هذا الوكيل. إذا لم تضبطه، يرجع النظام إلى Gemini/الاحتياطات الحالية.
          </div>

          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 text-xs font-bold sm:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
              <p className="text-[10px] text-slate-500">حالة الوكيل المحلي</p>
              <p className={agentDiag?.enabled ? 'mt-1 font-black text-emerald-700' : 'mt-1 font-black text-amber-700'}>{agentDiag?.enabled ? 'مفعل ويستخدم نموذجاً مفتوح المصدر' : 'غير مفعل — يستخدم Gemini/الاحتياطي'}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
              <p className="text-[10px] text-slate-500">مصدر الإعداد</p>
              <p className="mt-1 font-black text-[#0f2b46]">{agentSourceLabel}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
              <p className="text-[10px] text-slate-500">النموذج</p>
              <p className="mt-1 truncate font-mono text-[11px] font-black text-[#a8841a]" dir="ltr">{agentDiag?.model || '—'}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
              <p className="text-[10px] text-slate-500">Endpoint</p>
              <p className="mt-1 truncate font-mono text-[10px] font-bold text-slate-500" dir="ltr">{agentDiag?.baseUrl || '—'}</p>
            </div>
          </div>

          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            {SelectF('AI_AGENT_PROVIDER', 'محرك الوكيل الرئيسي', [
              { value: 'AUTO', label: 'AUTO — استخدم المحلي إن وجد وإلا Gemini' },
              { value: 'LOCAL_OPENAI', label: 'LOCAL_OPENAI — نموذج مفتوح المصدر محلي/ذاتي' },
              { value: 'GEMINI', label: 'GEMINI — تعطيل المحلي واستخدام Gemini' },
            ], 'للتشغيل المجاني اضبط LOCAL_OPENAI مع Ollama أو LM Studio أو vLLM.')}
            {F('AI_AGENT_MODEL', 'اسم نموذج الوكيل المحلي', 'qwen2.5:7b-instruct', 'text', 'مثال Ollama: qwen2.5:7b-instruct أو llama3.1:8b-instruct أو mistral:7b')}
            {F('AI_AGENT_BASE_URL', 'رابط خادم النموذج OpenAI-compatible', 'http://localhost:11434/v1', 'text', 'على Vercel لا يمكن استخدام localhost؛ يجب أن يكون رابط VPS/خادم عام آمن يشغل Ollama أو vLLM.')}
            {F('AI_AGENT_API_KEY', 'API Key اختياري للوكيل المحلي', data.secretsSet.AI_AGENT_API_KEY ? 'محفوظ — اكتب جديداً للتغيير' : 'اتركه فارغاً مع Ollama غالباً', 'password', 'مع Ollama غالباً أي قيمة مثل ollama تكفي؛ مع vLLM/خادم محمي ضع المفتاح هنا.')}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات الوكيل
            </Button>
            <Button onClick={testLocalAgent} disabled={testing} variant="outline" className="border-[#c9a227] font-extrabold text-[#a8841a] hover:bg-[#fffaf0]">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Bot className="ml-2 h-4 w-4" />} اختبار الوكيل المحلي
            </Button>
          </div>

          <div className="rounded-xl bg-slate-50 p-3 text-[10px] font-bold leading-relaxed text-slate-500">
            لتشغيل مجاني فعلياً تحتاج خادماً أو جهازاً يبقى متصلاً بالإنترنت ويشغل النموذج. المشاريع المفتوحة المصدر مجانية ككود، لكن التشغيل على آلاف الطلاب يحتاج موارد CPU/GPU وذاكرة واتصال مستقر.
          </div>
        </TabsContent>

        {/* ===== TURN ===== */}
        <TabsContent value="turn" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-600">
            <Network className="h-4 w-4 text-[#a8841a]" />
            خادم TURN يضمن اتصال الفيديو كونفرنس عبر شبكات NAT الصارمة وشركات الاتصالات وشبكات الجامعات: عندما يتعذر الاتصال المباشر (P2P) بين الطالب واللجنة تتوسط خوادمك البث بالفيديو والصوت. التوصية: نشر coturn على VPS عام (دليل جاهز في docs/turn-setup.md داخل المشروع).
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            {F('TURN_URL', 'عنوان خادم TURN (UDP)', 'turn:turn.aact.academy:3478', 'text', 'يبدأ بـ turn: ويشمل المنفذ — يُدخل تلقائياً في ICE Servers')}
            {F('TURN_TCP_URL', 'عنوان TURN احتياطي TCP/TLS', 'turns:turn.aact.academy:5349?transport=tcp', 'text', 'للشبكات التي تحجب UDP — يبدأ بـ turns: للـ TLS')}
            {F('TURN_USERNAME', 'اسم المستخدم', 'aact')}
            {F('TURN_CREDENTIAL', 'كلمة المرور', data.secretsSet.TURN_CREDENTIAL ? 'محفوظة — اكتب جديدة للتغيير' : '', 'password', 'نفس بيانات coturn (lt-cred-mech)')}
            {F('STUN_URLS', 'خوادم STUN (مفصولة بفواصل)', 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302', 'text', 'اكتشف العنوان العام — تُستخدم دائماً قبل TURN')}
          </div>
          <div className="flex items-center justify-between">
            <Badge className={data.turnConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
              {data.turnConfigured ? 'TURN مهيأ — اتصال مضمون عبر أي شبكة' : 'بدون TURN — الاتصال المباشر P2P عبر STUN فقط'}
            </Badge>
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات TURN
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
