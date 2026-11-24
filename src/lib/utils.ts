import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// تنظيف ردود المساعد الذكي من علامات ماركداون حرفية (**، __، `، #، قوائم)
// قبل عرضها — الردود تُعرض كنص عادي لا كماركداون، فالعلامات كانت تظهر
// حرفياً للمستخدم. منقولة حرفياً من وكيل واتساب العائم (Shell.tsx) لتُستخدم
// في كل مكان يُعرض فيه رد مساعد.
export function cleanAssistantReplyText(value: unknown): string {
  return String(value || '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
