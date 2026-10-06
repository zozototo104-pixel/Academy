'use client'

import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, MessageSquareText, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type DialogKind = 'confirm' | 'prompt'
type DialogTone = 'danger' | 'warning' | 'info' | 'success'

interface BaseOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: DialogTone
}

interface PromptOptions extends BaseOptions {
  defaultValue?: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
  minLength?: number
  fieldLabel?: string
}

interface DialogState extends PromptOptions {
  kind: DialogKind
}

const toneStyles: Record<DialogTone, { header: string; button: string; icon: any }> = {
  danger: { header: 'from-red-700 to-[#0f2b46]', button: 'bg-red-700 text-white hover:bg-red-800', icon: Trash2 },
  warning: { header: 'from-amber-600 to-[#0f2b46]', button: 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]', icon: AlertTriangle },
  info: { header: 'from-[#12365c] to-[#0f2b46]', button: 'bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]', icon: MessageSquareText },
  success: { header: 'from-emerald-700 to-[#0f2b46]', button: 'bg-emerald-700 text-white hover:bg-emerald-800', icon: CheckCircle2 },
}

export function useAdminActionDialog() {
  const [state, setState] = useState<DialogState | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const resolverRef = useRef<((value: boolean | string | null) => void) | null>(null)

  const close = useCallback((result: boolean | string | null) => {
    const resolver = resolverRef.current
    resolverRef.current = null
    setState(null)
    setError('')
    if (resolver) resolver(result)
  }, [])

  const confirmAction = useCallback((options: BaseOptions) => new Promise<boolean>((resolve) => {
    resolverRef.current = (result) => resolve(result === true)
    setValue('')
    setError('')
    setState({ kind: 'confirm', tone: 'warning', confirmLabel: 'تأكيد', cancelLabel: 'إلغاء', ...options })
  }), [])

  const promptAction = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => {
    resolverRef.current = (result) => resolve(typeof result === 'string' ? result : null)
    setValue(options.defaultValue || '')
    setError('')
    setState({ kind: 'prompt', tone: 'info', confirmLabel: 'متابعة', cancelLabel: 'إلغاء', ...options })
  }), [])

  const submit = useCallback(() => {
    if (!state) return
    if (state.kind === 'confirm') return close(true)
    const trimmed = value.trim()
    if (state.required && !trimmed) {
      setError('هذا الحقل مطلوب.')
      return
    }
    if (state.minLength && trimmed.length < state.minLength) {
      setError(`يجب ألا يقل النص عن ${state.minLength} أحرف.`)
      return
    }
    close(value)
  }, [close, state, value])

  const DialogNode = state ? (() => {
    const tone = toneStyles[state.tone || 'info']
    const Icon = tone.icon
    return (
      <Dialog open={!!state} onOpenChange={(open) => { if (!open) close(state.kind === 'confirm' ? false : null) }}>
        <DialogContent className="max-w-md rounded-[2rem] border border-[#0f2b46]/10 bg-white p-0" dir="rtl">
          <div className={`rounded-t-[2rem] bg-gradient-to-l ${tone.header} px-5 py-5 text-[#f5f0e1]`}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg font-black">
                <Icon className="h-5 w-5" /> {state.title}
              </DialogTitle>
              {state.description && <DialogDescription className="text-xs font-bold leading-6 text-[#f5f0e1]/80">{state.description}</DialogDescription>}
            </DialogHeader>
          </div>
          <div className="space-y-4 p-5">
            {state.kind === 'prompt' && (
              <div className="space-y-2">
                <Label className="text-xs font-black text-[#0f2b46]">{state.fieldLabel || 'الملاحظة'}</Label>
                {state.multiline ? (
                  <Textarea value={value} onChange={(e) => { setValue(e.target.value); setError('') }} placeholder={state.placeholder || ''} rows={4} className="font-bold leading-7" autoFocus />
                ) : (
                  <Input value={value} onChange={(e) => { setValue(e.target.value); setError('') }} placeholder={state.placeholder || ''} className="font-bold" autoFocus />
                )}
                {error && <p className="text-[11px] font-bold text-red-600">{error}</p>}
              </div>
            )}
            {state.kind === 'confirm' && state.description && (
              <div className="rounded-2xl border border-[#0f2b46]/10 bg-slate-50 p-4 text-sm font-bold leading-7 text-[#0f2b46]">{state.description}</div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => close(state.kind === 'confirm' ? false : null)} className="font-black">{state.cancelLabel || 'إلغاء'}</Button>
              <Button type="button" onClick={submit} className={`font-black ${tone.button}`}>{state.confirmLabel || 'تأكيد'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  })() : null

  return { confirmAction, promptAction, dialog: DialogNode }
}
