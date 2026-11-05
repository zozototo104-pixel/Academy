import { MeetingInviteView } from '@/components/aact/MeetingInviteView'

// صفحة دعوة اجتماع إداري برابط شخصي (يُخزَّن هاش رمزه فقط في قاعدة البيانات)
export default async function MeetingInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <MeetingInviteView token={token} />
}
