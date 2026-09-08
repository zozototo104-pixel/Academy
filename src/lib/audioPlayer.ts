// ===== مشغل الصوت المشترك — يعالج سياسة التشغيل التلقائي في iOS Safari =====
//
// المشكلة: آيفون يمنع audio.play() على عنصر صوت أُنشئ حديثاً بعد عمليات غير
// متزامنة (مثل انتظار رد خادم TTS) — يرمي NotAllowedError ولا يُسمع أي صوت.
//
// الحل المعتمد في التطبيقات الإنتاجية:
// 1. عنصر Audio واحد دائم (Singleton) يُعاد استخدامه في كل عمليات النطق —
//    بمجرد «فتحه» بلمسة المستخدم يبقى مصرحاً له بالتشغيل البرمجي طوال الجلسة.
// 2. فتح القناة تلقائياً بأول لمسة في الصفحة: نشغّل مقطعاً صامتاً (20ms)
//    داخل معالج اللمسة مباشرة — iOS يعتبر ذلك موافقة المستخدم على الصوت.
// 3. إعادة المحاولة بالفتح عند أي فشل (لو فُقد الإذن لسبب ما).

let sharedEl: HTMLAudioElement | null = null

// WAV صامت حقيقي: PCM 16-bit mono 8000Hz — 160 عينة صفر (~20 مللي ثانية)
const SILENT_WAV =
  'data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/** عنصر الصوت الدائم المشترك — يُنشأ مرة واحدة ويُعاد استخدامه دائماً */
export function getSharedAudio(): HTMLAudioElement {
  if (!sharedEl) {
    sharedEl = new Audio()
    sharedEl.setAttribute('playsinline', '') // تشغيل داخل الصفحة على iOS
    sharedEl.preload = 'auto'
    sharedEl.style.display = 'none'
  }
  return sharedEl
}

/** فتح قناة الصوت بلمسة المستخدم — تُستدعى مرة واحدة من مستوى الجذر (Shell) */
export function unlockAudioOnFirstGesture(): void {
  if (typeof window === 'undefined') return
  const unlock = () => {
    try {
      const a = getSharedAudio()
      a.src = SILENT_WAV
      const p = a.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {}
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('touchend', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('touchend', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
}

/**
 * تشغيل رابط صوتي على العنصر الدائم المشترك.
 * إن رفض المتصفح التشغيل نعيد المحاولة مرة واحدة بعد فتح القناة بلمسة وهمية.
 * تعيد true عند نجاح بدء التشغيل.
 */
export async function playOnSharedAudio(url: string): Promise<boolean> {
  const a = getSharedAudio()
  a.pause()
  a.src = url
  try {
    await a.play()
    return true
  } catch {
    // محاولة ثانية: فتح قسري للقناة ثم التشغيل فوراً
    try {
      a.src = SILENT_WAV
      await a.play().catch(() => {})
      a.src = url
      await a.play()
      return true
    } catch {
      return false
    }
  }
}
