# تقرير قياس الأداء — PR #67

هذا التقرير مبني على قراءة الكود في فرع `perf/measure` فقط. لا يحتوي اقتراحات التنفيذ أدناه على أي تعديل سلوكي مطبق في هذا الفرع.

## أ) جدول routes المقاسة

| route | عدد الاستعلامات | الاستعلامات المتسلسلة اللي ممكن تصير Promise.all | أي N+1 (استعلام جوا loop) | الحقول الكبيرة اللي بترجع | include أو select ثقيل |
|---|---:|---|---|---|---|
| `/api/admissions` | POST: تقريباً 9+ حسب نوع الطلب. GET: تقريباً 2–4 حسب `mine/ref/role`. | في POST: `getSettingNum('FEE_APPLICATION')` و`nextInvoiceNo()` مستقلان غالباً ويمكن دراستهما للتوازي قبل إنشاء `payment`. إشعارات البريد أصلاً داخل `Promise.all`. | يوجد loop محدود لتوليد reference حتى 5 محاولات `admissionApplication.findUnique`. داخل `nextInvoiceNo()` helper يوجد فحص وجود متكرر حتى يجد رقم فاتورة غير مستخدم. | لا يرجع base64؛ الملفات ترجع metadata و`storageKey` فقط. GET يرجع `payments.description` و`notes` يستعمل لاستخراج replacement request، وهي ليست ضخمة عادة. | `include` في GET يجلب `files`, `payments`, `theses`, `deliverables`, `supervisor`, `programRef` مع `select` محدود. |
| `/api/admin/question-bank` | GET: حوالي 8–9 عمليات مقاسة. POST/PATCH تختلف حسب action. | في GET يمكن دراسة توازي `pauseSetting`, `progress`, `jobs`, `questionStats`, و`listQuestions` بعد التحقق من وجود البرنامج. | لا يوجد DB داخل loop مباشر في route. `insertBankQuestions` يمر على الأسئلة في الذاكرة ثم `createMany` واحد. | `listQuestions` يرجع عناصر `questionBankItem` كاملة تقريباً، وتشمل حقول نصية كبيرة مثل `text`, `modelAnswer`, `sourceEvidence`, `correctRationale`, `distractorRationales`, `reviewNotes`. | `findMany` في `listQuestions` بدون `select`، لذلك هو أثقل جزء في الرد. |
| `/api/admin/knowledge-bank` | GET: 6 عمليات مقاسة. POST يختلف حسب action؛ `sanitize` paginated. | في GET يمكن توازي `total`, `booksCount`, و`v2BookCounts` بعد جلب العناصر/البرنامج إذا لم تعتمد الواجهة على ترتيبها. | في `sanitize` يوجد paging loop. داخله يتم تجهيز updates ثم تنفيذها بـ`Promise.all` لكل page؛ هذا ليس N+1 في GET لكنه قد يصبح كثير الكتابات في action التنظيف. | `items` قد تحتوي `summary` و`excerpt`، و`contextPreview` ينسخ جزءاً من الملخصات. عند `all=1` الحد يصل إلى 2000 عنصر. | `getProgramKnowledgeItems` هو helper ثقيل محتمل لأنه يحمّل عناصر معرفة متعددة وربما metadata كتب/وحدات حسب تطبيقه الداخلي. |
| `/api/admin/study-guides` | GET: 2. POST: تقريباً 5. PATCH/DELETE: 2 تقريباً. | في `buildSemesterGuide`: استعلام `program` ثم `unitGuidesForProgram` متسلسل لأن بناء الرد يحتاج البرنامج والوحدات، لكن داخل `unitGuidesForProgram` يمكن دراسة توازي تحميل `guides` فقط بعد معرفة ids، لذلك ليس مستقلاً تماماً. | لا يوجد DB داخل loop. | أدلة الدراسة ترجع JSON نصي كبير: `overview`, `sections`, `activities`, `discussionQuestions`, `objectives`, `keyTerms`. هذه حقول معروضة/محررة. | GET يستخدم `programStudyGuide.findMany` بدون `select`، لذلك يرجع كامل صفوف الأدلة. |
| `/api/admin/program-rules` | GET: 2. POST/PATCH/PUT تختلف حسب action. | في GET لا توجد استعلامات مستقلة كثيرة. في PUT بعد جلب البرنامج، `clearAdmissionAiReviewCacheForProgram` و`audit` متسلسلان بعد update، وهذا آمن وظيفياً لكن يمكن قياس أثرهما. | `uniqueProgramSlug` يحتوي loop يتحقق من slug حتى يجد قيمة غير مستخدمة. | `admissionRules` هو أكبر حقل مرشح، ثم `description`, `disclosureConsentText`, `trademarkNotice`, و`features`. | GET يرجع كل البرامج مع `admissionRules` كامل + `programSnapshot` يكرر جزءاً من نفس الحقول داخل `program`. |

## ب) تحليل `program-rules` وحجم 1.6MB

من قراءة الكود، GET يختار الحقول التالية لكل برنامج: `id`, `slug`, `titleAr`, `titleEn`, `description`, `category`, `hours`, `price`, `icon`, `features`, `active`, `order`, `credentialType`, `trademarkNotice`, `disclosureConsentText`, `admissionRules`, و`_count.units`.

السبب الأرجح لحجم 1.6MB هو أن الرد يرجع `admissionRules` كاملاً لكل برنامج في القائمة، ثم يضيف `rules` بعد `resolveRules(...)`، ويضيف `program: programSnapshot(p)` الذي يكرر كثيراً من حقول البرنامج نفسها. لذلك الحجم ليس من query واحدة فقط، بل من تضخيم serialization للرد.

ترتيب الحقول المرشحة حسب الحجم التقريبي من قراءة الكود:

1. `admissionRules`: JSON غير محدود ظاهرياً في route، ويعاد أيضاً بشكل مشتق داخل `rules`.
2. `program.rules` الناتج عن `resolveRules(...)`: نسخة مشتقة قد تكون كبيرة لأنها توسّع defaults/custom rules.
3. `program` snapshot: يكرر `description`, `features`, `trademarkNotice`, `disclosureConsentText`, و`admissionRules`.
4. `description`: حد schema في route حتى 5000 حرف.
5. `disclosureConsentText`: حتى 2000 حرف.
6. `trademarkNotice`: حتى 1200 حرف.
7. `features`: حتى 12 عنصر، كل عنصر حتى 180 حرف قبل التخزين.

ما تحتاجه الواجهة في القائمة غالباً: `id`, `slug`, `titleAr/titleEn`, `category`, `active`, `order/sortOrder`, `price`, `hours`, `_count.units`, و`custom`. ما يمكن تحميله عند الطلب: `admissionRules`, `rules`, `programSnapshot`, `description`, `disclosureConsentText`, `trademarkNotice`, وربما `features` إذا لم تكن ظاهرة في جدول القائمة.

## ج) فحص Prisma والاتصال

- `DATABASE_URL`: من قراءة `src/lib/db.ts` و`prisma/schema.prisma`، الكود لا يثبت أن `DATABASE_URL` يحتوي pooling مثل `pgbouncer` أو `connection_limit`. القيمة الفعلية موجودة في البيئة ولا تظهر في الكود.
- `directUrl`: غير موجودة في `datasource db`؛ الموجود فقط `url = env("DATABASE_URL")`.
- `PrismaClient`: يوجد singleton على مستوى module عبر `export const db = globalForPrisma.prisma ?? new PrismaClient(...)`. في التطوير يحفظه على `globalThis.prisma`. في الإنتاج لا ينشئ instance داخل request handler، بل على تحميل module/cold start.

## د) أول 5 إصلاحات أداء مقترحة — بدون تنفيذ

1. فصل `program-rules` إلى list خفيف وdetails عند الطلب.
   - الأثر المتوقع: تخفيض كبير لحجم رد القائمة، وربما إزالة معظم 1.6MB.
2. إضافة `select` صريح في `question-bank` لقائمة الأسئلة بدلاً من full rows.
   - الأثر المتوقع: تقليل حجم الرد وزمن serialization، خصوصاً مع `sourceEvidence` و`modelAnswer`.
3. تقليل payload `knowledge-bank` الافتراضي وإرسال `excerpt/summary` الطويلة عند فتح العنصر أو عند `all=1` فقط.
   - الأثر المتوقع: تقليل First API payload في لوحة الإدارة، خصوصاً للبرامج ذات بنك معرفة كبير.
4. تحويل بعض الاستعلامات المستقلة إلى `Promise.all` بعد قياس Server-Timing.
   - الأثر المتوقع: تقليل latency دون تغيير عدد queries، خصوصاً في GET لمسارات `question-bank` و`knowledge-bank`.
5. تحسين توليد الأرقام/المراجع التي تستخدم loops (`nextInvoiceNo`, slug/reference uniqueness) بآلية sequence أو retry على unique constraint.
   - الأثر المتوقع: تقليل أسوأ زمن في حالات التصادم وتقليل queries المتكررة.

## ملاحظات CI وbundle-report

- workflow `bundle-report` يشغّل `ANALYZE=true bunx next build` ولا يستدعي `bun run build`، حتى لا تعمل سكربتات Prisma/deploy/seed الموجودة في script `build`.
- السكربت `scripts/bundle-report-summary.mjs` يكتب في Job Summary جدول First Load JS من مخرجات `next build`، وأكبر chunks، والـchunks التي تحتوي مؤشرات `AdminBooks`, `AdminExtras`, `AdminQualityTab`, `AdminView`, `AdminSystemTab`.
- artifact analyzer يرفع HTML من `.next/analyze/*.html` باسم `next-bundle-analyzer`.
