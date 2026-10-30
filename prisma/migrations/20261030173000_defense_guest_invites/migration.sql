-- رابط اجتماع خارجي للمناقشة + دعوات ضيوف خارجيين لقاعة المناقشة
ALTER TABLE "ThesisSubmission" ADD COLUMN "defenseMeetingUrl" TEXT;

ALTER TABLE "DefenseParticipant" ADD COLUMN "guestInviteId" TEXT;
ALTER TABLE "DefenseParticipant" ADD COLUMN "guestSecretHash" TEXT;

CREATE TABLE "DefenseGuestInvite" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'COMMITTEE',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastJoinedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefenseGuestInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DefenseGuestInvite_tokenHash_key" ON "DefenseGuestInvite"("tokenHash");
CREATE INDEX "DefenseGuestInvite_thesisId_idx" ON "DefenseGuestInvite"("thesisId");

ALTER TABLE "DefenseGuestInvite" ADD CONSTRAINT "DefenseGuestInvite_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "ThesisSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
