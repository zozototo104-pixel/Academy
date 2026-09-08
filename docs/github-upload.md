# 📤 رفع المنصة إلى حسابك على GitHub — خطوة بخطوة

هذه الحزمة جاهزة للرفع على GitHub كما هي. لا تُرفع قاعدة البيانات ولا الأسرار (`.env` مستثنى عبر `.gitignore`).

---

## الطريقة الأولى — من المتصفح (الأسهل، 3 دقائق)

1. سجّل الدخول إلى حسابك على [github.com](https://github.com)
2. اضغط **+** أعلى اليمين ثم **New repository**
3. اختر اسماً مثل `aact-platform` واجعل الخصوصية **Private** أو **Public** حسب رغبتك، ثم اضغط **Create repository**
4. في صفحة المستودع الجديد اضغط **uploading an existing file**
5. فُكّ ضغط ملف `AACT-Platform-v1.3.zip` على جهازك، ثم **اسحب كل محتوياته** (لا المجلد نفسه) إلى نافذة الرفع
   - ملاحظة: يدعم GitHub السحب حتى 100 ملف للمرة الواحدة — إذا ظهرت رسالة، ارفع الملفات على دفعات
6. اكتب رسالة الالتزام الأولى مثل `AACT Digital Platform — first release` واضغط **Commit changes**

## الطريقة الثانية — من سطر الأوامر (الأدق)

```bash
# 1) فُكّ الضغط وادخل المجلد
unzip AACT-Platform-v1.3.zip -d aact-platform && cd aact-platform

# 2) هيّئ مستودع git محلي (الاسم والبريد حسابك أنت)
git init
git config user.name  "اسمك على GitHub"
git config user.email "بريدك-المرتبط-بـGitHub@example.com"

# 3) أول التزام
git add .
git commit -m "AACT Digital Platform — first release"

# 4) أنشئ المستودع أولاً من الموقع (الطريقة الأولى خطوة 2-3) ثم اربطه
git branch -M main
git remote add origin https://github.com/<اسم-حسابك>/aact-platform.git
git push -u origin main
```

سيطلب GitHub اسم المستخدم و**Personal Access Token** (وليس كلمة المرور): أنشئ توكناً من
`GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)` بصلاحية `repo`.

---

## بعد الرفع — كيف يشغّل أي شخص المشروع (أو أنت على جهاز آخر)

```bash
git clone https://github.com/<اسم-حسابك>/aact-platform.git
cd aact-platform
cp .env.example .env      # عدّل القيم إن رغبت
npm install               # أو: bun install
npx prisma db push        # إنشاء قاعدة البيانات
npm run db:seed           # بيانات أولية: 52 برنامجاً + حسابات تجريبية
npm run dev               # التشغيل على http://localhost:3000
```

> ملاحظة: أمر `db:seed` يعمل عبر Bun — إن لم يكن مثبتاً لديك نفّذ `npm i -g bun` ثم أعد المحاولة.

**حسابات تجريبية بعد التهيئة:**

| الحساب | البريد | كلمة المرور |
|--------|--------|-------------|
| الإدارة | `admin@aact.academy` | `Admin@2026` |
| طالب | `student@demo.com` | `Demo@2026` |

---

## ما لا يُرفع على GitHub (مستثنى تلقائياً في `.gitignore`)

- `.env` — أسرارك الحقيقية (SMTP، مفاتيح Stripe/PayPal، كلمات TURN) — يستنسخه الجميع من `.env.example`
- `db/*.db` — قاعدة البيانات المحلية
- `node_modules/` و `.next/`

## تحديث الحزمة مستقبلاً

بعد أي تعديل على الكود على جهازك:

```bash
git add . && git commit -m "وصف التعديل" && git push
```
