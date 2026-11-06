import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards for the Zoom-embed audio hint on the meeting invite page: browsers
// never autoplay audio inside the embedded Zoom client, so the member must
// be told — before joining and again above the live embed — to press Zoom's
// own audio icon. The hints must stay scoped to the embedded-Zoom path and
// the post-join banner must stay dismissible.

const root = join(import.meta.dir, '../..')
const component = readFileSync(join(root, 'src/components/aact/MeetingInviteView.tsx'), 'utf8')

describe('meeting invite Zoom audio hint guards', () => {
  test('pre-join note is shown only for external-Zoom meetings before the embed opens', () => {
    expect(component).toContain("!isPlatform && meeting?.provider === 'ZOOM' && !zoomConfig")
    expect(component).toContain('بعد الدخول إلى الاجتماع، اضغط أيقونة الصوت داخل نافذة Zoom لتفعيل السماع')
  })

  test('post-join banner sits with the embed, explains the browser rule, and is dismissible', () => {
    expect(component).toContain('لا تسمع الصوت؟ اضغط أيقونة الصوت (السماعة) داخل نافذة Zoom')
    expect(component).toContain('المتصفح لا يفعّل الصوت تلقائيًا عند الدخول')
    expect(component).toContain('!audioHintDismissed')
    expect(component).toContain('setAudioHintDismissed(true)')
    // The banner belongs to the embed block: it must appear after the
    // zoomConfig gate opens and before the Zoom root container renders.
    const gateIdx = component.indexOf('{zoomConfig && (')
    const bannerIdx = component.indexOf('لا تسمع الصوت؟')
    const rootIdx = component.indexOf('ref={zoomRootRef}')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(bannerIdx).toBeGreaterThan(gateIdx)
    expect(rootIdx).toBeGreaterThan(bannerIdx)
  })

  test('the hint never renders for the platform WebRTC room', () => {
    // Both hint surfaces are gated away from PLATFORM meetings: the pre-join
    // note requires !isPlatform and the banner lives inside the zoomConfig
    // (Zoom SDK) block only.
    expect(component).not.toContain("meeting?.provider === 'PLATFORM' && !zoomConfig")
    expect(component).toContain("const isPlatform = meeting?.provider === 'PLATFORM'")
  })
})
