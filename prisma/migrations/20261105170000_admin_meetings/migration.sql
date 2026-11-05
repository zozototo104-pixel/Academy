-- CreateTable
CREATE TABLE "AdminMeeting" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "agenda" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "provider" TEXT NOT NULL DEFAULT 'ZOOM',
    "meetingUrl" TEXT,
    "meetingPasscode" TEXT,
    "hostName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "aiAssistantEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minutesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminMeeting_status_startsAt_idx" ON "AdminMeeting"("status", "startsAt");

-- CreateTable
CREATE TABLE "AdminMeetingInvite" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "inviteeName" TEXT NOT NULL,
    "inviteeEmail" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMeetingInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminMeetingInvite_tokenHash_key" ON "AdminMeetingInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminMeetingInvite_meetingId_idx" ON "AdminMeetingInvite"("meetingId");

-- AddForeignKey
ALTER TABLE "AdminMeetingInvite" ADD CONSTRAINT "AdminMeetingInvite_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "AdminMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AdminMeetingAttendance" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inviteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'JOINED',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,

    CONSTRAINT "AdminMeetingAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminMeetingAttendance_meetingId_userId_key" ON "AdminMeetingAttendance"("meetingId", "userId");

-- CreateIndex
CREATE INDEX "AdminMeetingAttendance_meetingId_status_idx" ON "AdminMeetingAttendance"("meetingId", "status");

-- AddForeignKey
ALTER TABLE "AdminMeetingAttendance" ADD CONSTRAINT "AdminMeetingAttendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "AdminMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AdminMeetingSignal" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "fromPeer" TEXT NOT NULL,
    "toPeer" TEXT,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMeetingSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminMeetingSignal_meetingId_createdAt_idx" ON "AdminMeetingSignal"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminMeetingSignal" ADD CONSTRAINT "AdminMeetingSignal_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "AdminMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
