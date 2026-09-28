import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { ACADEMY_INFO } from '@/lib/academyData'
import { absoluteUrl } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'سياسة الخصوصية',
  description: 'سياسة خصوصية منصة الأكاديمية الأمريكية للاستشارات والتدريب وبيان استخدام البيانات في الموقع والواتساب والوكيل الذكي.',
  alternates: { canonical: '/privacy' },
  robots: { index: true, follow: true },
}

const updatedAt = '28 سبتمبر 2026'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/10 backdrop-blur">
      <h2 className="text-xl font-black text-white">{title}</h2>
      <div className="mt-4 space-y-3 text-sm font-semibold leading-8 text-white/68">{children}</div>
    </section>
  )
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#0f1c35] text-white" dir="rtl">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8">
        <Link href="/" className="inline-flex rounded-full border border-[#c9a227]/40 px-4 py-2 text-sm font-black text-[#d8b45c] hover:bg-[#c9a227]/10">
          العودة إلى الرئيسية
        </Link>

        <header className="mt-8 rounded-[2rem] border border-[#c9a227]/25 bg-[#172743] p-7 shadow-2xl shadow-black/20">
          <p className="text-sm font-bold text-[#d8b45c]">{ACADEMY_INFO.nameAr}</p>
          <h1 className="mt-3 text-3xl font-black sm:text-5xl">سياسة الخصوصية</h1>
          <p className="mt-4 max-w-3xl text-sm font-semibold leading-8 text-white/68">
            توضح هذه السياسة كيف تتعامل منصة {ACADEMY_INFO.nameAr} مع بيانات الزوار والمتقدمين والطلاب ومستخدمي واتساب والوكيل الذكي، وما هي خيارات التواصل وطلب حذف البيانات.
          </p>
          <p className="mt-3 text-xs font-bold text-white/45">آخر تحديث: {updatedAt}</p>
        </header>

        <div className="mt-8 grid gap-5">
          <Section title="1. البيانات التي قد نجمعها">
            <p>قد نجمع البيانات التي يزوّدنا بها المستخدم مباشرة عند تعبئة نموذج، إنشاء حساب، طلب التحاق، طلب خدمة، التواصل عبر واتساب، أو استخدام الوكيل الذكي.</p>
            <ul className="list-inside list-disc space-y-2">
              <li>الاسم وبيانات التواصل مثل البريد الإلكتروني ورقم الهاتف والدولة.</li>
              <li>بيانات طلب القبول أو الخدمة، مثل البرنامج المطلوب، المؤهلات، الخبرات، المرفقات، وإثباتات الدفع عند الحاجة.</li>
              <li>محتوى الرسائل والمحادثات مع الدعم أو الوكيل الذكي لأغراض الرد والمتابعة وتحسين جودة الخدمة.</li>
              <li>بيانات تقنية أساسية مثل عنوان IP، نوع المتصفح، سجلات الدخول، وحالة الطلبات، لأغراض الأمان والتشغيل.</li>
              <li>بيانات التحقق من الشهادات أو السجلات الأكاديمية عند استخدام صفحة التحقق العامة.</li>
            </ul>
          </Section>

          <Section title="2. كيف نستخدم البيانات">
            <ul className="list-inside list-disc space-y-2">
              <li>معالجة طلبات التسجيل والقبول والخدمات المهنية.</li>
              <li>التواصل مع المستخدم بخصوص الطلب أو الدراسة أو المدفوعات أو الشهادات.</li>
              <li>تشغيل الوكيل الذكي والرد على الاستفسارات المرتبطة بالأكاديمية والبرامج والخدمات.</li>
              <li>إدارة الحسابات، السجلات الأكاديمية، الامتحانات، الشهادات، والتحقق الإلكتروني.</li>
              <li>تحسين أمان المنصة، منع إساءة الاستخدام، ومعالجة الأخطاء التشغيلية.</li>
              <li>الوفاء بالمتطلبات النظامية أو الإدارية أو التعاقدية عند انطباقها.</li>
            </ul>
          </Section>

          <Section title="3. الواتساب وMeta والوكيل الذكي">
            <p>عند التواصل معنا عبر واتساب أو خدمات Meta، قد تمر بعض بيانات الرسائل عبر منصات Meta وواجهة WhatsApp Business API بحسب إعدادات مزود الخدمة. نستخدم هذه البيانات للرد على المستخدم ومتابعة طلباته فقط ضمن نطاق خدمات الأكاديمية.</p>
            <p>قد يستخدم الوكيل الذكي محتوى السؤال والسياق المسموح به داخل المنصة لتقديم رد مناسب. لا ينبغي للمستخدم إرسال بيانات حساسة غير مطلوبة عبر الدردشة العامة.</p>
          </Section>

          <Section title="4. مشاركة البيانات مع أطراف أخرى">
            <p>لا نبيع بيانات المستخدمين. قد نشارك البيانات فقط عند الحاجة التشغيلية مع مزودي البنية التقنية، البريد الإلكتروني، التخزين، الدفع، خدمات الذكاء الاصطناعي، أو منصات التواصل مثل WhatsApp/Meta، وبالقدر اللازم لتقديم الخدمة أو حماية المنصة.</p>
          </Section>

          <Section title="5. الاحتفاظ بالبيانات">
            <p>نحتفظ بالبيانات للمدة اللازمة لتقديم الخدمات التعليمية والمهنية، حفظ السجلات والوثائق والشهادات، معالجة النزاعات أو طلبات الدعم، والوفاء بالمتطلبات الإدارية. يمكن للمستخدم طلب مراجعة أو حذف بياناته وفق القسم التالي.</p>
          </Section>

          <Section title="6. طلب حذف البيانات أو تصحيحها">
            <p>يمكنك طلب حذف بياناتك أو تصحيحها عبر صفحة حذف البيانات:</p>
            <p>
              <Link className="font-black text-[#d8b45c] underline" href="/data-deletion">{absoluteUrl('/data-deletion')}</Link>
            </p>
            <p>كما يمكنك التواصل عبر البريد: <span dir="ltr">{ACADEMY_INFO.email}</span> أو واتساب: <span dir="ltr">{ACADEMY_INFO.whatsappDisplay}</span>. قد نحتاج للتحقق من هويتك قبل تنفيذ الطلب، وقد نحتفظ ببيانات محدودة إذا كانت لازمة قانونياً أو لإثبات شهادة أو سجل أكاديمي أو معاملة مالية.</p>
          </Section>

          <Section title="7. حماية البيانات">
            <p>نستخدم إجراءات تنظيمية وتقنية مناسبة لحماية الحسابات والطلبات والوثائق، مع تقييد الوصول للبيانات حسب الصلاحيات. ومع ذلك لا يمكن ضمان أمان أي نظام إلكتروني بنسبة مطلقة.</p>
          </Section>

          <Section title="8. التواصل معنا">
            <p>لأي سؤال حول هذه السياسة:</p>
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
