'use client'

import { useState } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { useAdminActionDialog } from '@/components/aact/AdminActionDialog'

interface RefreshPaymentAmountButtonProps {
  payment: {
    id: string
    status: string
  }
  onDone: () => void
}

export function RefreshPaymentAmountButton({ payment, onDone }: RefreshPaymentAmountButtonProps) {
  const { toast } = useToast()
  const { confirmAction, promptAction, dialog: actionDialog } = useAdminActionDialog()
  const [busy, setBusy] = useState(false)

  if (payment.status !== 'UNPAID') return <span>—</span>

  const refreshAmount = async () => {
    setBusy(true)
    try {
      const preview = await api<{ changed: boolean; oldAmount: number; newAmount: number; source?: string }>('/api/admin/payments', {
        method: 'PATCH',
        body: JSON.stringify({ id: payment.id, action: 'REFRESH_AMOUNT', dryRun: true }),
      })

      if (!preview.changed) {
        toast({ title: 'لا يوجد تغيير', description: 'المبلغ الحالي مطابق للمبلغ المحسوب من الإعدادات الحالية.' })
        return
      }

      const confirmed = await confirmAction({
        title: 'تحديث مبلغ فاتورة غير مدفوعة',
        description: 'سيتم تحديث مبلغ الفاتورة غير المدفوعة من ' + preview.oldAmount + ' دولار إلى ' + preview.newAmount + ' دولار.',
        confirmLabel: 'متابعة التحديث',
        tone: 'warning',
      })
      if (!confirmed) return

      const reason = await promptAction({
        title: 'سبب تحديث مبلغ الفاتورة',
        description: 'اكتب سبب تحديث مبلغ الفاتورة ليظهر في سجل التدقيق.',
        fieldLabel: 'سبب التحديث',
        placeholder: 'مثال: تعديل سعر البرنامج من قواعد القبول',
        required: true,
        minLength: 6,
        multiline: true,
        confirmLabel: 'تحديث المبلغ',
        tone: 'warning',
      })
      if (reason === null) return

      const trimmedReason = reason.trim()
      if (trimmedReason.length < 6) {
        toast({ title: 'سبب مطلوب', description: 'اكتب سبباً واضحاً لا يقل عن 6 أحرف.', variant: 'destructive' })
        return
      }

      await api('/api/admin/payments', {
        method: 'PATCH',
        body: JSON.stringify({ id: payment.id, action: 'REFRESH_AMOUNT', reason: trimmedReason }),
      })

      toast({ title: 'تم تحديث المبلغ', description: 'تم تحديث الفاتورة من ' + preview.oldAmount + ' دولار إلى ' + preview.newAmount + ' دولار' })
      onDone()
    } catch (e: any) {
      toast({ title: 'تعذر تحديث المبلغ', description: e?.message || 'حدث خطأ غير متوقع', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {actionDialog}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={refreshAmount}
        className="border-[#c9a227]/40 font-bold text-[#a8841a]"
      >
        {busy ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : <RefreshCw className="ml-1 h-3 w-3" />}
        تحديث المبلغ
      </Button>
    </>
  )
}
