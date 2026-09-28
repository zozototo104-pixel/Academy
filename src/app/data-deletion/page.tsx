import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { ACADEMY_INFO } from '@/lib/academyData'
import { absoluteUrl } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'تعليمات حذف البيانات',
  description: 'تعليمات طلب حذف بيانات المستخدم من منصة الأكاديمية الأمريكية للاستشارات والتدريب وطلبات واتساب وMeta.',
  alternates: { canonical: '/data-deletion' },
  robots: { index: true, follow: true },
}

const updatedAt = '28 سبتمبر 2026'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/10 backdrop-blur">
      <h2 className="text-xl font-black text-white">{title}</h2>
      <div className="mt-4 space-y-3 text-sm font-semibold leading-8 text-white/68">{children}</div>
    </section>
  )
}

export default function DataDeletionPage() {
  const subject = 'طلب حذف بيانات من منصة AACT'
  const body = `السلام عليكم،\n\nأطلب حذف بياناتي المرتبطة بمنصة ${ACADEMY_INFO.nameAr}.\n\nالاسم:\nالبريد المستخدم في التسجيل:\nرقم الهاتف أو واتساب:\nرقم الطلب أو الشهادة إن وجد:\nسبب الطلب أو ملاحظات إضافية:\n\nأقر أنني صاحب البيانات أو مفوض بطلب الحذف.`
  const mailto = `mailto:${ACADEMY_INFO.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  return (
    <main className="min-h-screen bg-[#0f1c35] text-white" dir="rtl">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8">
        <Link href="/" className="inline-flex rounded-full border border-[#c9a227]/40 px-4 py-2 text-sm font-black text-[#d8b45c] hover:bg-[#c9a227]/10">
          العودة إلى الرئيسية
        </Link>

        <header className="mt-8 rounded-[2rem] border border-[#c9a227]/25 bg-[#172743] p-7 shadow-2xl shadow-black/20">
          <p className="text-sm font-bold text-[#d8b45c]">{ACADEMY_INFO.nameAr}</p>
          <h1 className="mt-3 text-3xl font-black sm:text-5xl">تعليمات حذف البيانات</h1>
          <p className="mt-4 max-w-3xl text-sm font-semibold leading-8 text-white/68">
            هذه الصفحة توضّح كيف يستطيع المستخدم طلب حذف بياناته من منصة الأكاديمية، بما في ذلك البيانات المرتبطة بالحسابات والطلبات ومحادثات واتساب أو Meta عند انطباقها.
          </p>
          <p className="mt-3 text-xs font-bold text-white/45">آخر تحديث: {updatedAt}</p>
        </header>

        <div className="mt-8 grid gap-5">
          <Section title="1. ما البيانات التي يمكن طلب حذفها؟">
            <ul className="list-inside list-disc space-y-2">
              <li>بيانات الحساب مثل الاسم والبريد ورقم الهاتف والدولة.</li>
              <li>بيانات طلبات الالتحاق أو الخدمات، والمرفقات غير المطلوب الاحتفاظ بها.</li>
              <li>محادثات الدعم أو واتساب أو الوكيل الذكي المرتبطة بالمستخدم عند توفر إمكانية تحديدها.</li>
              <li>بيانات الاستخدام التقنية غير اللازمة للتشغيل أو الأمان.</li>
            </ul>
          </Section>

          <Section title="2. بيانات قد لا تُحذف فوراً">
            <p>قد نحتاج للاحتفاظ ببعض البيانات إذا كانت مرتبطة بسجل أكاديمي أو شهادة صادرة أو معاملة مالية أو التزام قانوني أو نزاع قائم أو مطلب أمني. في هذه الحالات سنوضح للمستخدم سبب الاحتفاظ الجزئي أو التأخير عند الرد على الطلب.</p>
          </Section>

          <Section title="3. طريقة إرسال طلب الحذف">
            <p>أرسل طلب الحذف إلى البريد الإلكتروني الرسمي، واذكر بيانات تساعدنا على تحديد السجل الصحيح:</p>
            <ul className="list-inside list-disc space-y-2">
              <li>الاسم الكامل.</li>
              <li>البريد المستخدم في المنصة.</li>
              <li>رقم الهاتف أو واتساب المستخدم.</li>
              <li>رقم الطلب أو الشهادة أو المرجع إن وجد.</li>
              <li>نوع البيانات المطلوب حذفها.</li>
            </ul>
            <p>
              <a className="inline-flex rounded-full bg-[#c9a227] px-5 py-3 text-sm font-black text-[#0f1c35] hover:bg-[#d8b45c]" href={mailto}>
                إرسال طلب حذف البيانات بالبريد
              </a>
            </p>
            <p>يمكنك أيضاً التواصل عبر واتساب: <span dir="ltr">{ACADEMY_INFO.whatsappDisplay}</span></p>
          </Section>

          <Section title="4. التحقق من هوية مقدم الطلب">
            <p>لحماية الحسابات والسجلات من الحذف غير المصرح به، قد نطلب تأكيد البريد أو رقم الهاتف أو تقديم معلومات إضافية تثبت أن مقدم الطلب هو صاحب البيانات أو مفوض عنه.</p>
          </Section>

          <Section title="5. مدة المعالجة">
            <p>سنراجع طلب الحذف ونرد في أقرب وقت عملي. قد تختلف مدة المعالجة حسب حجم البيانات وطبيعة الطلب والحاجة للتحقق من الهوية أو مراجعة السجلات المرتبطة بالشهادات والمعاملات.</p>
          </Section>

          <Section title="6. حذف بيانات Meta أو واتساب">
            <p>إذا وصلتنا بياناتك عبر واتساب أو خدمات Meta، يمكنك طلب حذف البيانات التي تحتفظ بها الأكاديمية ضمن أنظمتها. أما البيانات التي تحتفظ بها Meta نفسها فتخضع لسياسات وأدوات Meta الخاصة بالمستخدم.</p>
          </Section>

          <Section title="7. روابط ذات صلة">
            <ul className="list-inside list-disc space-y-2">
              <li><Link className="font-black text-[#d8b45c] underline" href="/privacy">سياسة الخصوصية</Link></li>
              <li><Link className="font-black text-[#d8b45c] underline" href="/terms">شروط الاستخدام</Link></li>
              <li>البريد الإلكتروني: <span dir="ltr">{ACADEMY_INFO.email}</span></li>
              <li>رابط هذه الصفحة: <span dir="ltr">{absoluteUrl('/data-deletion')}</span></li>
            </ul>
          </Section>
        </div>
      </div>
    </main>
  )
}
