import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { ACADEMY_INFO } from '@/lib/academyData'
import { absoluteUrl } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'شروط الاستخدام',
  description: 'شروط استخدام منصة الأكاديمية الأمريكية للاستشارات والتدريب وخدمات القبول والواتساب والوكيل الذكي.',
  alternates: { canonical: '/terms' },
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

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#0f1c35] text-white" dir="rtl">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8">
        <Link href="/" className="inline-flex rounded-full border border-[#c9a227]/40 px-4 py-2 text-sm font-black text-[#d8b45c] hover:bg-[#c9a227]/10">
          العودة إلى الرئيسية
        </Link>

        <header className="mt-8 rounded-[2rem] border border-[#c9a227]/25 bg-[#172743] p-7 shadow-2xl shadow-black/20">
          <p className="text-sm font-bold text-[#d8b45c]">{ACADEMY_INFO.nameAr}</p>
          <h1 className="mt-3 text-3xl font-black sm:text-5xl">شروط الاستخدام</h1>
          <p className="mt-4 max-w-3xl text-sm font-semibold leading-8 text-white/68">
            باستخدامك لهذا الموقع أو نماذج التسجيل أو خدمات واتساب أو الوكيل الذكي، فإنك توافق على هذه الشروط بالقدر الذي ينطبق على استخدامك للخدمات.
          </p>
          <p className="mt-3 text-xs font-bold text-white/45">آخر تحديث: {updatedAt}</p>
        </header>

        <div className="mt-8 grid gap-5">
          <Section title="1. نطاق الخدمة">
            <p>توفر منصة {ACADEMY_INFO.nameAr} خدمات تعريف بالبرامج والخدمات المهنية، استقبال طلبات الالتحاق والخدمات، إدارة السجلات والوثائق، التواصل مع المتقدمين والطلاب، وخدمات مساندة مثل الوكيل الذكي والتحقق من الشهادات.</p>
            <p>قد تختلف شروط كل برنامج أو خدمة بحسب المتطلبات المنشورة داخل الصفحة الخاصة به أو حسب قرار الإدارة بعد مراجعة الوثائق.</p>
          </Section>

          <Section title="2. الحسابات والبيانات">
            <ul className="list-inside list-disc space-y-2">
              <li>يلتزم المستخدم بتقديم بيانات صحيحة وحديثة عند إنشاء حساب أو تعبئة طلب.</li>
              <li>يتحمل المستخدم مسؤولية الحفاظ على سرية بيانات الدخول الخاصة به.</li>
              <li>يحق للإدارة طلب وثائق إضافية للتحقق من الهوية أو المؤهل أو الخبرة أو الدفع.</li>
              <li>أي استخدام آلي أو إساءة استخدام للتسجيل أو النماذج أو الدردشة قد يؤدي إلى تعليق الحساب أو رفض الطلب.</li>
            </ul>
          </Section>

          <Section title="3. القبول والبرامج والخدمات">
            <p>لا يعني تعبئة الطلب أو التواصل عبر واتساب أو الوكيل الذكي قبولاً نهائياً في أي برنامج أو خدمة. يخضع القبول أو الاعتماد أو إصدار الوثائق لمراجعة الإدارة واستكمال المتطلبات والرسوم المقررة عند انطباقها.</p>
            <p>قد تُحدّث الأكاديمية شروط البرامج والخدمات والرسوم والمواعيد والمخرجات وفق الحاجة التشغيلية أو الأكاديمية، مع الحفاظ على حقوق الطلبات المعتمدة حسب السجلات الرسمية للمنصة.</p>
          </Section>

          <Section title="4. المدفوعات والرسوم">
            <p>تُعرض الرسوم وطريقة السداد داخل المنصة أو عبر إشعار الإدارة بحسب نوع الطلب. بعض الرسوم قد تكون غير مستردة إذا كانت مرتبطة بفتح ملف أو مراجعة إدارية أو خدمة منفذة فعلياً، وذلك حسب السياسة المعتمدة لكل خدمة.</p>
          </Section>

          <Section title="5. الوكيل الذكي وواتساب">
            <p>يقدم الوكيل الذكي إجابات مساعدة بناءً على البيانات المتاحة داخل المنصة والمعلومات العامة المنشورة. لا تُعد ردود الوكيل قراراً إدارياً نهائياً ما لم تؤكدها الإدارة أو تظهر في السجل الرسمي للطلب.</p>
            <p>يجب عدم إرسال بيانات حساسة غير مطلوبة عبر الدردشة العامة. عند الحاجة إلى وثائق أو مدفوعات أو قرارات رسمية، يتم اتباع المسار المعتمد داخل المنصة أو عبر الإدارة.</p>
          </Section>

          <Section title="6. الملكية الفكرية والاستخدام المقبول">
            <p>تعود حقوق المحتوى والتصميم والمواد المنشورة في المنصة إلى أصحابها أو إلى الأكاديمية بحسب الحالة. لا يجوز نسخ أو إعادة نشر أو استخدام المواد بشكل مضلل أو تجاري دون إذن.</p>
            <p>يحظر استخدام المنصة في انتحال الهوية، إرسال بيانات مزيفة، محاولة اختراق النظام، إنشاء حسابات جماعية آلية، أو تعطيل الخدمة.</p>
          </Section>

          <Section title="7. حدود المسؤولية">
            <p>نسعى لتوفير خدمات مستقرة ودقيقة، لكن قد تحدث انقطاعات أو أخطاء تقنية أو تأخيرات خارجة عن السيطرة. لا تتحمل المنصة مسؤولية أي خسائر غير مباشرة ناتجة عن استخدام غير صحيح أو بيانات غير دقيقة يقدمها المستخدم.</p>
          </Section>

          <Section title="8. الخصوصية وحذف البيانات">
            <p>يخضع استخدام البيانات إلى سياسة الخصوصية المنشورة هنا:</p>
            <p><Link className="font-black text-[#d8b45c] underline" href="/privacy">{absoluteUrl('/privacy')}</Link></p>
            <p>ويمكن طلب حذف البيانات من هنا:</p>
            <p><Link className="font-black text-[#d8b45c] underline" href="/data-deletion">{absoluteUrl('/data-deletion')}</Link></p>
          </Section>

          <Section title="9. التواصل">
            <ul className="list-inside list-disc space-y-2">
              <li>البريد الإلكتروني: <span dir="ltr">{ACADEMY_INFO.email}</span></li>
              <li>واتساب: <span dir="ltr">{ACADEMY_INFO.whatsappDisplay}</span></li>
              <li>الموقع: <span dir="ltr">{absoluteUrl('/')}</span></li>
            </ul>
          </Section>
        </div>
      </div>
    </main>
  )
}
