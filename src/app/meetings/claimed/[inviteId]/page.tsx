import { MeetingInviteView } from '@/components/aact/MeetingInviteView'

// صفحة اجتماع بالحساب: للمدعو الذي استلم دعوته — الدخول من حسابه
// دون الحاجة للرمز الخام (الحق من صف الدعوة المستلَمة).
export default async function ClaimedMeetingPage({ params }: { params: Promise<{ inviteId: string }> }) {
  const { inviteId } = await params
  return (
    <main className="min-h-screen bg-[#eef0f5] px-4 py-10" dir="rtl">
      <div className="mx-auto mb-6 max-w-2xl text-center">
        <div className="text-xl font-black text-[#0f2b46]">أكاديمية AACT</div>
        <div className="text-sm font-bold text-slate-500">قاعة الاجتماعات</div>
      </div>
      <MeetingInviteView inviteId={inviteId} />
    </main>
  )
}
