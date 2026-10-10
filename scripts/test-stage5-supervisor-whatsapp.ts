import assert from 'node:assert/strict'
import { OFFICIAL_INFO_UNAVAILABLE_REPLY, officialValueOrUnavailable } from '../src/lib/ai'
import { wrapUntrustedUiContextForTest } from '../src/app/api/chat/route'
import { buildDefenseLiveSystemInstruction, buildDefenseOnlyContextForTest } from '../src/lib/defense-agent-context'
import { shouldCreateHumanHandoffForOpenConversation } from '../src/lib/human-handoff'
import { supervisorNeedsGeneralProgramCatalogForTest } from '../src/lib/platform-agent'
import { formatProgramKnowledge, stripSupervisorContactDataForTest } from '../src/lib/supervisor-ai'
import { maskWhatsAppPhone, whatsappWaIdHash } from '../src/lib/whatsapp-privacy'

function testSupervisorContextStripsPii() {
  const output = stripSupervisorContactDataForTest('اسم الطالب محمد، بريده test@example.com ورقمه +970 598 400 510')
  assert(!output.includes('test@example.com'))
  assert(!output.includes('+970'))
  assert(output.includes('[بريد محجوب]'))
  assert(output.includes('[رقم محجوب]'))
}

function testSourceLineHasNoInventedPage() {
  const withPage = formatProgramKnowledge({ knowledgeItems: [{ title: 'الفصل الأول', summary: 'شرح المصدر', category: 'CONCEPT', book: { title: 'كتاب الحوكمة' }, sourceNote: 'الوحدة الأولى', pageStart: 12 }] })
  assert(withPage.includes('كتاب الحوكمة'))
  assert(withPage.includes('ص 12'))
  const withoutPage = formatProgramKnowledge({ knowledgeItems: [{ title: 'الفصل الثاني', summary: 'شرح المصدر', category: 'CONCEPT', book: { title: 'كتاب المخاطر' } }] })
  assert(!withoutPage.includes('ص '))
}

function testUnavailableOfficialInfo() {
  assert.equal(officialValueOrUnavailable(''), OFFICIAL_INFO_UNAVAILABLE_REPLY)
  assert.equal(officialValueOrUnavailable('30 يوماً'), '30 يوماً')
}

function testWhatsAppNumberMaskedAndHashed() {
  const phone = '+970598400510'
  assert.notEqual(whatsappWaIdHash(phone), phone)
  assert(maskWhatsAppPhone(phone).includes('****'))
  assert(!maskWhatsAppPhone(phone).includes(phone))
}

async function testHandoffIdempotencyIntentShape() {
  assert.equal(shouldCreateHumanHandoffForOpenConversation(null), true)
  assert.equal(shouldCreateHumanHandoffForOpenConversation({ id: 'open-request' }), false)
}

async function main() {
  for (const fn of [testSupervisorContextStripsPii, testSourceLineHasNoInventedPage, testUnavailableOfficialInfo, testWhatsAppNumberMaskedAndHashed, testHandoffIdempotencyIntentShape]) {
    await fn()
    console.log(`✓ ${fn.name}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
