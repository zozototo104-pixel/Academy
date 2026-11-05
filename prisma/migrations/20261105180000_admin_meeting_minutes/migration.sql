-- CreateTable
CREATE TABLE "AdminMeetingNote" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMeetingNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminMeetingNote_meetingId_createdAt_idx" ON "AdminMeetingNote"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminMeetingNote" ADD CONSTRAINT "AdminMeetingNote_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "AdminMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AdminMeetingMinutes" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "decisions" TEXT,
    "actionItems" TEXT,
    "deferred" TEXT,
    "generatedFrom" TEXT NOT NULL DEFAULT 'AGENDA_AND_NOTES',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminMeetingMinutes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminMeetingMinutes_meetingId_key" ON "AdminMeetingMinutes"("meetingId");

-- AddForeignKey
ALTER TABLE "AdminMeetingMinutes" ADD CONSTRAINT "AdminMeetingMinutes_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "AdminMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AdminMeetingAgentEvent" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMeetingAgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminMeetingAgentEvent_meetingId_createdAt_idx" ON "AdminMeetingAgentEvent"("meetingId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminMeetingAgentEvent" ADD CONSTRAINT "AdminMeetingAgentEvent_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "AdminMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
