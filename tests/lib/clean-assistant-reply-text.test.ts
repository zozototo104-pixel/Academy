/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { cleanAssistantReplyText } from '../../src/lib/utils'

// منقول حرفياً من وكيل واتساب العائم (Shell.tsx) إلى src/lib/utils.ts.
// هذه الاختبارات تثبّت السلوك الحالي: إزالة علامات ماركداون حرفية من ردود
// المساعد قبل عرضها كنص عادي — وهي ما كانت تظهر حرفياً (**...**) في
// فقاعات المحادثة على الموبايل.
describe('cleanAssistantReplyText', () => {
  test('strips **bold** markers but keeps the words (reported chat defect)', () => {
    expect(cleanAssistantReplyText('**دبلوم الإسعاف النفسي الأولي (PFA)**')).toBe(
      'دبلوم الإسعاف النفسي الأولي (PFA)',
    )
    expect(cleanAssistantReplyText('راجع **الإسعافات الأولية النفسية** أولاً')).toBe(
      'راجع الإسعافات الأولية النفسية أولاً',
    )
  })

  test('strips __underline__ and `code` markers', () => {
    expect(cleanAssistantReplyText('__مهم__ و`كود`')).toBe('مهم وكود')
  })

  test('strips heading markers', () => {
    expect(cleanAssistantReplyText('## العنوان\nنص عادي')).toBe('العنوان\nنص عادي')
  })

  test('converts list markers to bullets', () => {
    expect(cleanAssistantReplyText('- أولاً\n- ثانياً')).toBe('• أولاً\n• ثانياً')
  })

  test('collapses 3+ newlines to two', () => {
    expect(cleanAssistantReplyText('أ\n\n\n\nب')).toBe('أ\n\nب')
  })

  test('plain text passes through unchanged; empty input returns empty', () => {
    expect(cleanAssistantReplyText('نص عادي بلا علامات')).toBe('نص عادي بلا علامات')
    expect(cleanAssistantReplyText('')).toBe('')
    expect(cleanAssistantReplyText(null)).toBe('')
    expect(cleanAssistantReplyText(undefined)).toBe('')
  })
})
