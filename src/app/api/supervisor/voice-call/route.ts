import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify } from '@/lib/notify'

const ACTIVE_STATUSES = ['RINGING', 'ACTIVE']
const SIGNAL_TYPES = new Set(['OFFER', 'ANSWER', 'ICE', 'HANGUP'])

async function settingValue(key: string) {
  return (await db.setting.findUnique({ where: { key } }).catch(() => null))?.value?.trim() || ''
}

async function rtcConfig() {
  const turnUrl = await settingValue('TURN_URL')
  const turnUsername = await settingValue('TURN_USERNAME')
  const turnCredential = await settingValue('TURN_CREDENTIAL')
  const iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }]
  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrl.split(',').map((x) => x.trim()).filter(Boolean),
      username: turnUsername,
      credential: turnCredential,
    })
  }
  return { iceServers }
}

async function admissionForUser(admissionId: string, user: any) {
  const app = await db.admissionApplication.findUnique({
    where: { id: admissionId },
    include: { supervisor: { select: { id: true, name: true } } },
  })
  if (!app) return null
  const isStudent = user.role === 'STUDENT' && (app.userId === user.id || app.email?.toLowerCase() === user.email?.toLowerCase())
  const isSupervisor = user.role === 'SUPERVISOR' && app.supervisorId === user.id
  const isAdmin = user.role === 'ADMIN'
  if (!isStudent && !isSupervisor && !isAdmin) return null
  return app
}

async function callForUser(callId: string, user: any) {
  const call = await db.supervisorVoiceCall.findUnique({ where: { id: callId } })
  if (!call) return null
  const app = await admissionForUser(call.admissionId, user)
  if (!app) return null
  return { call, app }
}

function publicCall(call: any) {
  if (!call) return null
  return {
    id: call.id,
    admissionId: call.admissionId,
    studentId: call.studentId,
    supervisorId: call.supervisorId,
    initiatorId: call.initiatorId,
    initiatorRole: call.initiatorRole,
    status: call.status,
    startedAt: call.startedAt,
    joinedAt: call.joinedAt,
    endedAt: call.endedAt,
    endedReason: call.endedReason,
    updatedAt: call.updatedAt,
  }
}

async function fullCallPayload(callId: string) {
  const call = await db.supervisorVoiceCall.findUnique({
    where: { id: callId },
    include: { signals: { orderBy: { createdAt: 'asc' }, take: 300 } },
  })
  return {
    call: publicCall(call),
    signals: (call?.signals || []).map((s) => ({
      id: s.id,
      callId: s.callId,
      fromId: s.fromId,
      fromRole: s.fromRole,
      type: s.type,
      payload: s.payload,
      createdAt: s.createdAt,
    })),
    rtcConfig: await rtcConfig(),
  }
}

function userSignalRole(user: any) {
  if (user.role === 'ADMIN') return 'SUPERVISOR'
  if (user.role === 'SUPERVISOR') return 'SUPERVISOR'
  return 'STUDENT'
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const callId = req.nextUrl.searchParams.get('callId') || ''
    const admissionId = req.nextUrl.searchParams.get('admissionId') || ''

    if (callId) {
      const access = await callForUser(callId, user)
      if (!access) return NextResponse.json({ error: 'لا تملك صلاحية هذه المكالمة' }, { status: 403 })
      return NextResponse.json(await fullCallPayload(callId))
    }

    if (!admissionId) return NextResponse.json({ error: 'معرّف الطالب/الطلب مطلوب' }, { status: 400 })
    const app = await admissionForUser(admissionId, user)
    if (!app) return NextResponse.json({ error: 'لا تملك صلاحية هذه المتابعة' }, { status: 403 })

    // تنظيف المكالمات العالقة القديمة حتى لا تبقى حالة الرنين للأبد.
    const staleBefore = new Date(Date.now() - 1000 * 60 * 20)
    await db.supervisorVoiceCall.updateMany({
      where: { admissionId, status: { in: ACTIVE_STATUSES }, updatedAt: { lt: staleBefore } },
      data: { status: 'MISSED', endedAt: new Date(), endedReason: 'انتهت مهلة انتظار المكالمة' },
    }).catch(() => null)

    const call = await db.supervisorVoiceCall.findFirst({
      where: { admissionId, status: { in: ACTIVE_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      include: { signals: { orderBy: { createdAt: 'asc' }, take: 300 } },
    })
    if (!call) return NextResponse.json({ call: null, signals: [], rtcConfig: await rtcConfig() })
    return NextResponse.json({
      call: publicCall(call),
      signals: call.signals.map((s) => ({ id: s.id, callId: s.callId, fromId: s.fromId, fromRole: s.fromRole, type: s.type, payload: s.payload, createdAt: s.createdAt })),
      rtcConfig: await rtcConfig(),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor voice call GET error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر قراءة حالة المكالمة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const action = String(body.action || '').toLowerCase()

    if (action === 'create') {
      const admissionId = String(body.admissionId || '')
      const app = await admissionForUser(admissionId, user)
      if (!app) return NextResponse.json({ error: 'لا تملك صلاحية بدء مكالمة لهذا الطالب' }, { status: 403 })
      if (!app.userId) return NextResponse.json({ error: 'لا يمكن بدء مكالمة قبل ربط الطلب بحساب طالب' }, { status: 400 })
      if (!app.supervisorId && user.role === 'STUDENT') return NextResponse.json({ error: 'لا يوجد مشرف بشري معيّن لهذا الطلب بعد' }, { status: 400 })

      await db.supervisorVoiceCall.updateMany({
        where: { admissionId, status: { in: ACTIVE_STATUSES } },
        data: { status: 'ENDED', endedAt: new Date(), endedReason: 'تم بدء مكالمة جديدة' },
      }).catch(() => null)

      const call = await db.supervisorVoiceCall.create({
        data: {
          admissionId,
          studentId: app.userId,
          supervisorId: app.supervisorId || (user.role !== 'STUDENT' ? user.id : null),
          initiatorId: user.id,
          initiatorRole: userSignalRole(user),
          status: 'RINGING',
        },
      })
      const otherUserId = userSignalRole(user) === 'STUDENT' ? app.supervisorId : app.userId
      await notify(otherUserId || null, 'SUPERVISION_CALL', 'مكالمة صوتية من المشرف/الطالب', `${app.fullName} — توجد مكالمة صوتية مباشرة بانتظار الانضمام.`, userSignalRole(user) === 'STUDENT' ? 'supervisor' : 'dashboard')
      return NextResponse.json(await fullCallPayload(call.id))
    }

    if (action === 'join') {
      const callId = String(body.callId || '')
      const access = await callForUser(callId, user)
      if (!access) return NextResponse.json({ error: 'لا تملك صلاحية الانضمام لهذه المكالمة' }, { status: 403 })
      const call = await db.supervisorVoiceCall.update({
        where: { id: callId },
        data: { status: 'ACTIVE', joinedAt: access.call.joinedAt || new Date() },
      })
      return NextResponse.json(await fullCallPayload(call.id))
    }

    if (action === 'signal') {
      const callId = String(body.callId || '')
      const type = String(body.type || '').toUpperCase()
      if (!SIGNAL_TYPES.has(type)) return NextResponse.json({ error: 'نوع إشارة WebRTC غير صالح' }, { status: 400 })
      const access = await callForUser(callId, user)
      if (!access) return NextResponse.json({ error: 'لا تملك صلاحية إرسال إشارة لهذه المكالمة' }, { status: 403 })
      if (access.call.status === 'ENDED' || access.call.status === 'DECLINED' || access.call.status === 'MISSED') {
        return NextResponse.json({ error: 'المكالمة منتهية' }, { status: 400 })
      }
      const payload = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload || {})
      const signal = await db.supervisorVoiceSignal.create({
        data: { callId, fromId: user.id, fromRole: userSignalRole(user), type, payload },
      })
      await db.supervisorVoiceCall.update({ where: { id: callId }, data: { updatedAt: new Date() } }).catch(() => null)
      return NextResponse.json({ ok: true, signal })
    }

    if (action === 'end' || action === 'decline') {
      const callId = String(body.callId || '')
      const access = await callForUser(callId, user)
      if (!access) return NextResponse.json({ error: 'لا تملك صلاحية إنهاء هذه المكالمة' }, { status: 403 })
      const finalStatus = action === 'decline' ? 'DECLINED' : 'ENDED'
      const call = await db.supervisorVoiceCall.update({
        where: { id: callId },
        data: { status: finalStatus, endedAt: new Date(), endedById: user.id, endedReason: String(body.reason || (action === 'decline' ? 'تم رفض المكالمة' : 'تم إنهاء المكالمة')).slice(0, 250) },
      })
      await db.supervisorVoiceSignal.create({
        data: { callId, fromId: user.id, fromRole: userSignalRole(user), type: 'HANGUP', payload: JSON.stringify({ reason: call.endedReason, status: finalStatus }) },
      }).catch(() => null)
      return NextResponse.json({ ok: true, call: publicCall(call) })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor voice call POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تنفيذ إجراء المكالمة' }, { status: 500 })
  }
}
