# دليل نشر خادم TURN لقاعات المناقشة (اجتياز NAT)

قاعات المناقشة تعمل WebRTC P2P عبر STUN افتراضياً. عند وجود NAT صارم (شركات،
جامعات، بعض شبكات الجوال) يلزم خادم **TURN** يتوسط البث. هذا الدليل ينشر
**coturn** على أي VPS عام في 5 دقائق.

---

## 1. المتطلبات

- VPS عام بعنوان IP عام (Ubuntu 22.04+ / Debian 12) — 1 vCPU و1GB RAM كافيان
- فتح المنافذ في جدار الحماية:

| المنفذ | البروتوكول | الغرض |
|--------|-----------|-------|
| 3478 | TCP+UDP | TURN القياسي |
| 5349 | TCP | TURN عبر TLS (turns:) |
| 49152-65535 | UDP | نطاق relay |

## 2. التثبيت عبر Docker (الأسهل)

```bash
mkdir -p /opt/coturn && cd /opt/coturn

cat > turnserver.conf <<'CONF'
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=IP_العام_للخادم
realm=aact.academy
server-name=aact.academy
lt-cred-mech
user=aact:كلمة_مرور_قوية
min-port=49152
max-port=65535
no-cli
no-tlsv1
no-tlsv1_1
# شهادة TLS (اختياري لكن يُنصح به لتفادي الحجب)
# cert=/etc/letsencrypt/live/turn.aact.academy/fullchain.pem
# pkey=/etc/letsencrypt/live/turn.aact.academy/privkey.pem
CONF

docker run -d --name coturn --restart always \
  --network host \
  -v /opt/coturn/turnserver.conf:/etc/coturn/turnserver.conf \
  coturn/coturn
```

## 3. التثبيت المباشر (بلا Docker)

```bash
apt update && apt install -y coturn
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
# ضع إعدادات القسم 2 في /etc/turnserver.conf ثم:
systemctl enable --now coturn
```

## 4. التحقق من العمل

افتح [Trickle ICE Tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
وأدخل:

```
turn:IP_الخادم:3478
username: aact
credential: كلمة_المرور
```

يجب أن يظهر مرشح بنوع `relay` — هذا هو الدليل على أن TURN يعمل.

## 5. الربط بالمنصة

من لوحة الإدارة → **إعدادات النظام → TURN للفيديو**:

| الحقل | القيمة |
|-------|--------|
| عنوان TURN (UDP) | `turn:turn.aact.academy:3478` |
| TURN احتياطي TCP/TLS | `turns:turn.aact.academy:5349?transport=tcp` |
| اسم المستخدم | `aact` |
| كلمة المرور | نفس كلمة مرور turnserver.conf |

أو عبر متغيرات البيئة في `.env`:

```env
TURN_URL="turn:turn.aact.academy:3478"
TURN_TCP_URL="turns:turn.aact.academy:5349?transport=tcp"
TURN_USERNAME="aact"
TURN_CREDENTIAL="كلمة_المرور"
```

ستتحول شارة القاعة تلقائياً من `P2P / STUN` إلى **TURN مفعل** ويتصل الجميع
حتى خلف أقسى شبكات NAT.

## ملاحظات أمنية

- استخدم كلمة مرور طويلة عشوائية — بيانات TURN تُوزَّع للمستخدمين المصادقين
  فقط عبر `/api/webrtc/config` (401 للمجهول)
- إن أردت بيانات اعتماد مؤقتة صالحة لساعات (HMAC credentials) فهي إضافة
  سهلة على `src/app/api/webrtc/config/route.ts` باستخدام `secret` ثابت
- راقب استهلاك الباندوذ — كل جلسة relay تستهلك ضعف البث
