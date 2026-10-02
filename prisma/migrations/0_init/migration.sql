-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "emailVerificationTokenHash" TEXT,
    "emailVerificationExpiresAt" TIMESTAMP(3),
    "emailVerificationSentAt" TIMESTAMP(3),
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT,
    "role" TEXT NOT NULL DEFAULT 'STUDENT',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiLiveUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'SUPERVISOR',
    "freeMinutesUsed" INTEGER NOT NULL DEFAULT 0,
    "paidMinutesUsed" INTEGER NOT NULL DEFAULT 0,
    "sessionsCount" INTEGER NOT NULL DEFAULT 0,
    "lastSessionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiLiveUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiLiveCredit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "remainingMinutes" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ADMIN_GRANT',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "paymentId" TEXT,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiLiveCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Program" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "hours" INTEGER,
    "price" INTEGER,
    "icon" TEXT NOT NULL DEFAULT 'graduation-cap',
    "features" TEXT,
    "admissionRules" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "semestersCount" INTEGER,
    "academicReadinessStatus" TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION',
    "registrationStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "academicApproved" BOOLEAN NOT NULL DEFAULT false,
    "academicApprovedAt" TIMESTAMP(3),
    "academicApprovedById" TEXT,
    "curriculumDueAt" TIMESTAMP(3),
    "curriculumPreparationNote" TEXT,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "semester" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "content" TEXT NOT NULL,
    "objectives" TEXT,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completedUnits" TEXT NOT NULL DEFAULT '[]',
    "examReadiness" TEXT NOT NULL DEFAULT '[]',
    "finalScore" DOUBLE PRECISION,
    "certificateNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "passScore" INTEGER NOT NULL DEFAULT 60,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT,
    "correctAnswer" TEXT,
    "modelAnswer" TEXT,
    "points" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "feedback" TEXT,
    "aiGraded" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "examType" TEXT NOT NULL,
    "answersJson" TEXT NOT NULL,
    "current" INTEGER NOT NULL DEFAULT 0,
    "startedAtMs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerText" TEXT,
    "selectedOption" INTEGER,
    "isCorrect" BOOLEAN,
    "points" DOUBLE PRECISION,
    "maxPoints" INTEGER,
    "aiFeedback" TEXT,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'TEXT',
    "kind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT,
    "rating" TEXT NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAcademicMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileDigest" TEXT,
    "strengths" TEXT,
    "weaknesses" TEXT,
    "conceptsToReview" TEXT,
    "recommendedNextActions" TEXT,
    "lastConversationSummary" TEXT,
    "examSignals" TEXT,
    "thesisSignals" TEXT,
    "lastFileAnalysis" TEXT,
    "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastExamAt" TIMESTAMP(3),
    "lastDefenseAt" TIMESTAMP(3),
    "interactionsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentAcademicMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "admissionId" TEXT,
    "enrollmentId" TEXT,
    "agentId" TEXT,
    "invoiceNo" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "receiptNo" TEXT,
    "provider" TEXT,
    "providerRef" TEXT,
    "checkoutUrl" TEXT,
    "paidViaWebhook" BOOLEAN NOT NULL DEFAULT false,
    "cryptoNetwork" TEXT,
    "cryptoWalletAddress" TEXT,
    "cryptoTxHash" TEXT,
    "cryptoVerificationStatus" TEXT,
    "cryptoVerificationNote" TEXT,
    "cryptoVerifiedAt" TIMESTAMP(3),
    "cryptoVerificationRaw" JSONB,
    "paidAt" TIMESTAMP(3),
    "payerName" TEXT,
    "payerEmail" TEXT,
    "payerCountry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "grade" TEXT,
    "country" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT,
    "enrollmentId" TEXT,
    "admissionId" TEXT,
    "agentId" TEXT,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyRepresentative" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "fullName" TEXT NOT NULL,
    "displayTitle" TEXT,
    "degreeTitle" TEXT,
    "academicRank" TEXT,
    "country" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "territory" TEXT,
    "city" TEXT,
    "specialization" TEXT,
    "representativeRole" TEXT NOT NULL DEFAULT 'COUNTRY_REPRESENTATIVE',
    "shortBio" TEXT,
    "rawBio" TEXT,
    "professionalBio" TEXT,
    "worksSummary" TEXT,
    "achievements" TEXT,
    "publicContactNote" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "whatsapp" TEXT,
    "website" TEXT,
    "profilePhotoUrl" TEXT,
    "profilePhotoName" TEXT,
    "profilePhotoMime" TEXT,
    "profilePhotoSize" INTEGER,
    "profilePhotoStorageProvider" TEXT,
    "profilePhotoStorageKey" TEXT,
    "officialCardUrl" TEXT,
    "officialCardName" TEXT,
    "officialCardMime" TEXT,
    "officialCardSize" INTEGER,
    "officialCardStorageProvider" TEXT,
    "officialCardStorageKey" TEXT,
    "qrToken" TEXT NOT NULL,
    "verifyPhoneLast4Hash" TEXT,
    "verifyEmailLast4Hash" TEXT,
    "aiRewriteStatus" TEXT NOT NULL DEFAULT 'NOT_RUN',
    "aiRewriteNote" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "sourceAgentApplicationId" TEXT,
    "sourceUserId" TEXT,
    "onboardingStatus" TEXT NOT NULL DEFAULT 'ADMIN_CREATED',
    "onboardingToken" TEXT,
    "onboardingSubmittedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyRepresentative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyRepresentativeFile" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "externalUrl" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "storageProvider" TEXT,
    "storageKey" TEXT,
    "fileUrl" TEXT,
    "extractedText" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyRepresentativeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MicroCredential" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT,
    "skillArea" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "learningOutcome" TEXT NOT NULL,
    "criteria" JSONB,
    "badgeCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicroCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMicroCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "microCredentialId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "evidence" TEXT,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "UserMicroCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactMessage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanHandoffRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "contactMessageId" TEXT,
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "contactedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HumanHandoffRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppConversation" (
    "id" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "waIdHash" TEXT NOT NULL,
    "phoneMasked" TEXT NOT NULL,
    "displayName" TEXT,
    "phoneNumberId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'BOT_ACTIVE',
    "handoffRequestId" TEXT,
    "assignedToId" TEXT,
    "assignedToName" TEXT,
    "assignedAt" TIMESTAMP(3),
    "humanClosedAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "whatsappMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rawType" TEXT,
    "status" TEXT,
    "meta" JSONB,
    "sentById" TEXT,
    "sentByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThesisSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "admissionId" TEXT,
    "title" TEXT NOT NULL,
    "abstract" TEXT NOT NULL,
    "fileNote" TEXT,
    "reviewNote" TEXT,
    "fileStorageProvider" TEXT,
    "fileStorageKey" TEXT,
    "fileUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "defenseDate" TIMESTAMP(3),
    "committee" TEXT,
    "agentMember" TEXT,
    "defenseStatus" TEXT,
    "aiScore" DOUBLE PRECISION,
    "aiRecommendation" TEXT,
    "defenseCompletedAt" TIMESTAMP(3),
    "defenseMinutes" TEXT,
    "recordingData" TEXT,
    "recordingStorageProvider" TEXT,
    "recordingStorageKey" TEXT,
    "recordingUrl" TEXT,
    "recordingMime" TEXT,
    "recordingSize" INTEGER,
    "recordingDurationSec" INTEGER,
    "resultScore" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThesisSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThesisReviewNote" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT,
    "visibleToStudent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThesisReviewNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThesisTopic" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "objectives" TEXT,
    "methodology" TEXT,
    "keywords" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "proposedById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThesisTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThesisTopicRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "topicId" TEXT,
    "proposedTitle" TEXT NOT NULL,
    "rationale" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThesisTopicRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefenseMessage" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefenseMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'AGENCY',
    "accreditationType" TEXT,
    "orgName" TEXT NOT NULL,
    "repName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "territory" TEXT,
    "experience" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "contractNo" TEXT,
    "commissionRate" DOUBLE PRECISION,
    "committeeFee" DOUBLE PRECISION,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDocument" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" TEXT,
    "storageProvider" TEXT,
    "storageKey" TEXT,
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueShareTransaction" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "programCountry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueShareTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionApplication" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "nationalId" TEXT,
    "birthDate" TIMESTAMP(3),
    "address" TEXT,
    "education" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "programId" TEXT,
    "documents" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'AWAITING_FEE',
    "aiReview" TEXT,
    "aiVerdict" TEXT,
    "aiScore" INTEGER,
    "aiReviewedAt" TIMESTAMP(3),
    "userId" TEXT,
    "supervisorId" TEXT,
    "supervisorAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "thesisDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supervisionMode" TEXT NOT NULL DEFAULT 'AI',

    CONSTRAINT "AdmissionApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TuitionInstallmentAppeal" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "userId" TEXT,
    "programId" TEXT,
    "enrollmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedInitialAmount" DOUBLE PRECISION NOT NULL,
    "proposedSchedule" TEXT,
    "reason" TEXT,
    "adminNote" TEXT,
    "approvedInitialAmount" DOUBLE PRECISION,
    "firstSemesterRequiredAmount" DOUBLE PRECISION,
    "finalRequiredAmount" DOUBLE PRECISION,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TuitionInstallmentAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorChannelMessage" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT,
    "studentId" TEXT NOT NULL,
    "supervisorId" TEXT,
    "senderId" TEXT,
    "senderRole" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "audioData" TEXT,
    "audioStorageProvider" TEXT,
    "audioStorageKey" TEXT,
    "audioUrl" TEXT,
    "audioMime" TEXT,
    "audioSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorVoiceCall" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "supervisorId" TEXT,
    "initiatorId" TEXT,
    "initiatorRole" TEXT NOT NULL DEFAULT 'SUPERVISOR',
    "status" TEXT NOT NULL DEFAULT 'RINGING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupervisorVoiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorVoiceSignal" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "fromId" TEXT,
    "fromRole" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorVoiceSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorAssessment" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "supervisorId" TEXT,
    "programId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'DAILY_TEST',
    "semester" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "aiGradingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceBookIds" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "passScore" INTEGER NOT NULL DEFAULT 60,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdByRole" TEXT NOT NULL DEFAULT 'SUPERVISOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupervisorAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorAssessmentQuestion" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT,
    "correctAnswer" TEXT,
    "modelAnswer" TEXT,
    "sourceEvidence" TEXT,
    "sourceBookTitle" TEXT,
    "cognitiveSkill" TEXT,
    "difficulty" TEXT,
    "correctRationale" TEXT,
    "points" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "SupervisorAssessmentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorAssessmentAttempt" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "feedback" TEXT,
    "aiGraded" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gradedAt" TIMESTAMP(3),

    CONSTRAINT "SupervisorAssessmentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorAssessmentAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerText" TEXT,
    "selectedOption" INTEGER,
    "isCorrect" BOOLEAN,
    "points" DOUBLE PRECISION,
    "maxPoints" INTEGER,
    "aiFeedback" TEXT,

    CONSTRAINT "SupervisorAssessmentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleEn" TEXT,
    "author" TEXT,
    "year" TEXT,
    "description" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "data" TEXT,
    "storageProvider" TEXT,
    "storageKey" TEXT,
    "fileUrl" TEXT,
    "link" TEXT,
    "textContent" TEXT,
    "semester" INTEGER,
    "levelPolicy" TEXT,
    "readingDepth" TEXT,
    "assessmentOrientation" TEXT,
    "linkReadStatus" TEXT DEFAULT 'NOT_ATTEMPTED',
    "linkReadNote" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookUploadChunk" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER,
    "chunk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookUploadChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookKnowledgeItem" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "bookId" TEXT,
    "semester" INTEGER,
    "category" TEXT NOT NULL DEFAULT 'CONCEPT',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "excerpt" TEXT,
    "keywords" TEXT,
    "importance" INTEGER NOT NULL DEFAULT 50,
    "sourceNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookKnowledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionBankItem" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "knowledgeItemId" TEXT,
    "bookId" TEXT,
    "unitId" TEXT,
    "semester" INTEGER,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT,
    "correctAnswer" TEXT,
    "modelAnswer" TEXT,
    "sourceEvidence" TEXT,
    "sourceBookTitle" TEXT,
    "sourceLocator" TEXT,
    "cognitiveSkill" TEXT,
    "difficulty" TEXT,
    "correctRationale" TEXT,
    "distractorRationales" TEXT,
    "qualityFlags" TEXT,
    "reviewNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "generatedBy" TEXT NOT NULL DEFAULT 'AI',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "qualityScore" INTEGER NOT NULL DEFAULT 70,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramStudyGuide" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "overview" TEXT NOT NULL,
    "objectives" TEXT,
    "keyTerms" TEXT,
    "sections" TEXT,
    "activities" TEXT,
    "discussionQuestions" TEXT,
    "sourceKnowledgeIds" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "generatedBy" TEXT NOT NULL DEFAULT 'AI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramStudyGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramAssignment" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "semester" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL DEFAULT 'REPORT',
    "points" INTEGER NOT NULL DEFAULT 10,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "dueDays" INTEGER,
    "rubric" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentSubmission" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answerText" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "data" TEXT,
    "fileStorageProvider" TEXT,
    "fileStorageKey" TEXT,
    "fileUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "score" DOUBLE PRECISION,
    "feedback" TEXT,
    "gradedBy" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gradedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramExam" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATING',
    "semester" INTEGER NOT NULL DEFAULT 1,
    "errorNote" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 120,
    "passScore" INTEGER NOT NULL DEFAULT 60,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "booksUsed" TEXT,
    "generatedBy" TEXT NOT NULL DEFAULT 'AI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramQuestion" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT,
    "correctAnswer" TEXT,
    "modelAnswer" TEXT,
    "sourceEvidence" TEXT,
    "sourceBookTitle" TEXT,
    "sourceChapter" TEXT,
    "sourceLocator" TEXT,
    "cognitiveSkill" TEXT,
    "difficulty" TEXT,
    "correctRationale" TEXT,
    "distractorRationales" TEXT,
    "qualityFlags" TEXT,
    "reviewNotes" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "points" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',

    CONSTRAINT "ProgramQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramExamAttempt" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "feedback" TEXT,
    "durationUsedMin" INTEGER,
    "submittedAt" TIMESTAMP(3),
    "appealStatus" TEXT NOT NULL DEFAULT 'NONE',
    "appealReason" TEXT,
    "appealResponse" TEXT,
    "finalScore" DOUBLE PRECISION,
    "appealedAt" TIMESTAMP(3),
    "proctoringEnabled" BOOLEAN NOT NULL DEFAULT false,
    "proctoringLog" TEXT,
    "proctoringSnapshot" TEXT,
    "proctoringSnapshotStorageProvider" TEXT,
    "proctoringSnapshotStorageKey" TEXT,
    "proctoringSnapshotUrl" TEXT,
    "proctoringSnapshotMime" TEXT,
    "proctoringSnapshotSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerText" TEXT,
    "selectedOption" INTEGER,
    "isCorrect" BOOLEAN,
    "points" DOUBLE PRECISION,
    "maxPoints" INTEGER,
    "aiFeedback" TEXT,

    CONSTRAINT "ProgramAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefenseParticipant" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tz" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefenseParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefenseSignal" (
    "id" TEXT NOT NULL,
    "thesisId" TEXT NOT NULL,
    "fromPeer" TEXT NOT NULL,
    "toPeer" TEXT,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefenseSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionDocument" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" TEXT,
    "storageProvider" TEXT,
    "storageKey" TEXT,
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceDeliverable" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "storageProvider" TEXT,
    "storageKey" TEXT,
    "fileUrl" TEXT,
    "externalUrl" TEXT,
    "certificateId" TEXT,
    "verificationUrl" TEXT,
    "meetingAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "visibleToStudent" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceDeliverable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_emailVerificationTokenHash_idx" ON "User"("emailVerificationTokenHash");

-- CreateIndex
CREATE INDEX "User_emailVerifiedAt_idx" ON "User"("emailVerifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "AiLiveUsage_month_purpose_idx" ON "AiLiveUsage"("month", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "AiLiveUsage_userId_month_purpose_key" ON "AiLiveUsage"("userId", "month", "purpose");

-- CreateIndex
CREATE INDEX "AiLiveCredit_userId_status_idx" ON "AiLiveCredit"("userId", "status");

-- CreateIndex
CREATE INDEX "AiLiveCredit_expiresAt_idx" ON "AiLiveCredit"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Program_slug_key" ON "Program"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_userId_programId_key" ON "Enrollment"("userId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_unitId_key" ON "Exam"("unitId");

-- CreateIndex
CREATE INDEX "ExamDraft_userId_updatedAt_idx" ON "ExamDraft"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ExamDraft_examId_examType_idx" ON "ExamDraft"("examId", "examType");

-- CreateIndex
CREATE UNIQUE INDEX "ExamDraft_userId_examId_examType_key" ON "ExamDraft"("userId", "examId", "examType");

-- CreateIndex
CREATE INDEX "ChatFeedback_rating_status_createdAt_idx" ON "ChatFeedback"("rating", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ChatFeedback_programId_status_idx" ON "ChatFeedback"("programId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChatFeedback_messageId_userId_key" ON "ChatFeedback"("messageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAcademicMemory_userId_key" ON "StudentAcademicMemory"("userId");

-- CreateIndex
CREATE INDEX "StudentAcademicMemory_lastInteractionAt_idx" ON "StudentAcademicMemory"("lastInteractionAt");

-- CreateIndex
CREATE INDEX "StudentAcademicMemory_lastExamAt_idx" ON "StudentAcademicMemory"("lastExamAt");

-- CreateIndex
CREATE INDEX "StudentAcademicMemory_lastDefenseAt_idx" ON "StudentAcademicMemory"("lastDefenseAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_invoiceNo_key" ON "Payment"("invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_serial_key" ON "Certificate"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_qrToken_key" ON "Certificate"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyRepresentative_slug_key" ON "AcademyRepresentative"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyRepresentative_qrToken_key" ON "AcademyRepresentative"("qrToken");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_status_sortOrder_idx" ON "AcademyRepresentative"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_country_region_idx" ON "AcademyRepresentative"("country", "region");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_featured_status_idx" ON "AcademyRepresentative"("featured", "status");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_sourceAgentApplicationId_idx" ON "AcademyRepresentative"("sourceAgentApplicationId");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_sourceUserId_idx" ON "AcademyRepresentative"("sourceUserId");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_onboardingToken_idx" ON "AcademyRepresentative"("onboardingToken");

-- CreateIndex
CREATE INDEX "AcademyRepresentative_deletedAt_idx" ON "AcademyRepresentative"("deletedAt");

-- CreateIndex
CREATE INDEX "AcademyRepresentativeFile_representativeId_displayOrder_idx" ON "AcademyRepresentativeFile"("representativeId", "displayOrder");

-- CreateIndex
CREATE INDEX "AcademyRepresentativeFile_kind_idx" ON "AcademyRepresentativeFile"("kind");

-- CreateIndex
CREATE INDEX "AcademyRepresentativeFile_storageProvider_idx" ON "AcademyRepresentativeFile"("storageProvider");

-- CreateIndex
CREATE UNIQUE INDEX "MicroCredential_badgeCode_key" ON "MicroCredential"("badgeCode");

-- CreateIndex
CREATE INDEX "MicroCredential_programId_active_idx" ON "MicroCredential"("programId", "active");

-- CreateIndex
CREATE INDEX "MicroCredential_skillArea_idx" ON "MicroCredential"("skillArea");

-- CreateIndex
CREATE INDEX "UserMicroCredential_userId_valid_idx" ON "UserMicroCredential"("userId", "valid");

-- CreateIndex
CREATE INDEX "UserMicroCredential_microCredentialId_valid_idx" ON "UserMicroCredential"("microCredentialId", "valid");

-- CreateIndex
CREATE UNIQUE INDEX "UserMicroCredential_userId_microCredentialId_key" ON "UserMicroCredential"("userId", "microCredentialId");

-- CreateIndex
CREATE INDEX "HumanHandoffRequest_status_createdAt_idx" ON "HumanHandoffRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HumanHandoffRequest_source_sourceRef_idx" ON "HumanHandoffRequest"("source", "sourceRef");

-- CreateIndex
CREATE INDEX "HumanHandoffRequest_requesterId_createdAt_idx" ON "HumanHandoffRequest"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "HumanHandoffRequest_contactMessageId_idx" ON "HumanHandoffRequest"("contactMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_waIdHash_key" ON "WhatsAppConversation"("waIdHash");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_status_lastMessageAt_idx" ON "WhatsAppConversation"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_lastMessageAt_idx" ON "WhatsAppConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_phoneNumberId_idx" ON "WhatsAppConversation"("phoneNumberId");

-- CreateIndex
CREATE INDEX "WhatsAppConversationMessage_conversationId_createdAt_idx" ON "WhatsAppConversationMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppConversationMessage_whatsappMessageId_idx" ON "WhatsAppConversationMessage"("whatsappMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppConversationMessage_direction_createdAt_idx" ON "WhatsAppConversationMessage"("direction", "createdAt");

-- CreateIndex
CREATE INDEX "ThesisReviewNote_thesisId_createdAt_idx" ON "ThesisReviewNote"("thesisId", "createdAt");

-- CreateIndex
CREATE INDEX "ThesisReviewNote_stage_idx" ON "ThesisReviewNote"("stage");

-- CreateIndex
CREATE INDEX "ThesisTopic_programId_status_idx" ON "ThesisTopic"("programId", "status");

-- CreateIndex
CREATE INDEX "ThesisTopic_source_idx" ON "ThesisTopic"("source");

-- CreateIndex
CREATE INDEX "ThesisTopicRequest_userId_status_idx" ON "ThesisTopicRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "ThesisTopicRequest_programId_status_idx" ON "ThesisTopicRequest"("programId", "status");

-- CreateIndex
CREATE INDEX "ThesisTopicRequest_topicId_idx" ON "ThesisTopicRequest"("topicId");

-- CreateIndex
CREATE INDEX "AgentDocument_storageProvider_idx" ON "AgentDocument"("storageProvider");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionApplication_reference_key" ON "AdmissionApplication"("reference");

-- CreateIndex
CREATE INDEX "TuitionInstallmentAppeal_admissionId_status_idx" ON "TuitionInstallmentAppeal"("admissionId", "status");

-- CreateIndex
CREATE INDEX "TuitionInstallmentAppeal_userId_status_idx" ON "TuitionInstallmentAppeal"("userId", "status");

-- CreateIndex
CREATE INDEX "TuitionInstallmentAppeal_programId_idx" ON "TuitionInstallmentAppeal"("programId");

-- CreateIndex
CREATE INDEX "TuitionInstallmentAppeal_enrollmentId_idx" ON "TuitionInstallmentAppeal"("enrollmentId");

-- CreateIndex
CREATE INDEX "SupervisorChannelMessage_admissionId_idx" ON "SupervisorChannelMessage"("admissionId");

-- CreateIndex
CREATE INDEX "SupervisorChannelMessage_studentId_createdAt_idx" ON "SupervisorChannelMessage"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "SupervisorChannelMessage_supervisorId_createdAt_idx" ON "SupervisorChannelMessage"("supervisorId", "createdAt");

-- CreateIndex
CREATE INDEX "SupervisorVoiceCall_admissionId_status_idx" ON "SupervisorVoiceCall"("admissionId", "status");

-- CreateIndex
CREATE INDEX "SupervisorVoiceCall_studentId_status_idx" ON "SupervisorVoiceCall"("studentId", "status");

-- CreateIndex
CREATE INDEX "SupervisorVoiceCall_supervisorId_status_idx" ON "SupervisorVoiceCall"("supervisorId", "status");

-- CreateIndex
CREATE INDEX "SupervisorVoiceCall_createdAt_idx" ON "SupervisorVoiceCall"("createdAt");

-- CreateIndex
CREATE INDEX "SupervisorVoiceSignal_callId_createdAt_idx" ON "SupervisorVoiceSignal"("callId", "createdAt");

-- CreateIndex
CREATE INDEX "SupervisorVoiceSignal_fromId_idx" ON "SupervisorVoiceSignal"("fromId");

-- CreateIndex
CREATE INDEX "SupervisorAssessment_admissionId_idx" ON "SupervisorAssessment"("admissionId");

-- CreateIndex
CREATE INDEX "SupervisorAssessment_studentId_status_idx" ON "SupervisorAssessment"("studentId", "status");

-- CreateIndex
CREATE INDEX "SupervisorAssessment_supervisorId_idx" ON "SupervisorAssessment"("supervisorId");

-- CreateIndex
CREATE INDEX "SupervisorAssessment_programId_idx" ON "SupervisorAssessment"("programId");

-- CreateIndex
CREATE INDEX "SupervisorAssessmentQuestion_assessmentId_idx" ON "SupervisorAssessmentQuestion"("assessmentId");

-- CreateIndex
CREATE INDEX "SupervisorAssessmentAttempt_assessmentId_idx" ON "SupervisorAssessmentAttempt"("assessmentId");

-- CreateIndex
CREATE INDEX "SupervisorAssessmentAttempt_studentId_submittedAt_idx" ON "SupervisorAssessmentAttempt"("studentId", "submittedAt");

-- CreateIndex
CREATE INDEX "SupervisorAssessmentAnswer_attemptId_idx" ON "SupervisorAssessmentAnswer"("attemptId");

-- CreateIndex
CREATE INDEX "SupervisorAssessmentAnswer_questionId_idx" ON "SupervisorAssessmentAnswer"("questionId");

-- CreateIndex
CREATE INDEX "BookUploadChunk_bookId_idx" ON "BookUploadChunk"("bookId");

-- CreateIndex
CREATE INDEX "BookUploadChunk_uploadId_idx" ON "BookUploadChunk"("uploadId");

-- CreateIndex
CREATE UNIQUE INDEX "BookUploadChunk_uploadId_index_key" ON "BookUploadChunk"("uploadId", "index");

-- CreateIndex
CREATE INDEX "BookKnowledgeItem_programId_idx" ON "BookKnowledgeItem"("programId");

-- CreateIndex
CREATE INDEX "BookKnowledgeItem_bookId_idx" ON "BookKnowledgeItem"("bookId");

-- CreateIndex
CREATE INDEX "BookKnowledgeItem_programId_semester_idx" ON "BookKnowledgeItem"("programId", "semester");

-- CreateIndex
CREATE INDEX "BookKnowledgeItem_category_idx" ON "BookKnowledgeItem"("category");

-- CreateIndex
CREATE INDEX "QuestionBankItem_programId_status_idx" ON "QuestionBankItem"("programId", "status");

-- CreateIndex
CREATE INDEX "QuestionBankItem_programId_difficulty_idx" ON "QuestionBankItem"("programId", "difficulty");

-- CreateIndex
CREATE INDEX "QuestionBankItem_programId_type_idx" ON "QuestionBankItem"("programId", "type");

-- CreateIndex
CREATE INDEX "QuestionBankItem_knowledgeItemId_idx" ON "QuestionBankItem"("knowledgeItemId");

-- CreateIndex
CREATE INDEX "QuestionBankItem_bookId_idx" ON "QuestionBankItem"("bookId");

-- CreateIndex
CREATE INDEX "QuestionBankItem_unitId_idx" ON "QuestionBankItem"("unitId");

-- CreateIndex
CREATE INDEX "ProgramStudyGuide_programId_idx" ON "ProgramStudyGuide"("programId");

-- CreateIndex
CREATE INDEX "ProgramStudyGuide_status_idx" ON "ProgramStudyGuide"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramStudyGuide_programId_semester_key" ON "ProgramStudyGuide"("programId", "semester");

-- CreateIndex
CREATE INDEX "AssignmentSubmission_userId_idx" ON "AssignmentSubmission"("userId");

-- CreateIndex
CREATE INDEX "AssignmentSubmission_assignmentId_idx" ON "AssignmentSubmission"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentSubmission_assignmentId_userId_key" ON "AssignmentSubmission"("assignmentId", "userId");

-- CreateIndex
CREATE INDEX "ProgramQuestion_examId_cognitiveSkill_idx" ON "ProgramQuestion"("examId", "cognitiveSkill");

-- CreateIndex
CREATE INDEX "ProgramQuestion_examId_difficulty_idx" ON "ProgramQuestion"("examId", "difficulty");

-- CreateIndex
CREATE INDEX "ProgramQuestion_sourceBookTitle_idx" ON "ProgramQuestion"("sourceBookTitle");

-- CreateIndex
CREATE UNIQUE INDEX "DefenseParticipant_peerId_key" ON "DefenseParticipant"("peerId");

-- CreateIndex
CREATE INDEX "AdmissionDocument_storageProvider_idx" ON "AdmissionDocument"("storageProvider");

-- CreateIndex
CREATE INDEX "ServiceDeliverable_admissionId_status_idx" ON "ServiceDeliverable"("admissionId", "status");

-- CreateIndex
CREATE INDEX "ServiceDeliverable_type_idx" ON "ServiceDeliverable"("type");

-- CreateIndex
CREATE INDEX "ServiceDeliverable_visibleToStudent_idx" ON "ServiceDeliverable"("visibleToStudent");

-- CreateIndex
CREATE INDEX "ServiceDeliverable_storageProvider_idx" ON "ServiceDeliverable"("storageProvider");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiLiveUsage" ADD CONSTRAINT "AiLiveUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiLiveCredit" ADD CONSTRAINT "AiLiveCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamDraft" ADD CONSTRAINT "ExamDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatFeedback" ADD CONSTRAINT "ChatFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatFeedback" ADD CONSTRAINT "ChatFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAcademicMemory" ADD CONSTRAINT "StudentAcademicMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "AdmissionApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "AdmissionApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyRepresentativeFile" ADD CONSTRAINT "AcademyRepresentativeFile_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "AcademyRepresentative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MicroCredential" ADD CONSTRAINT "MicroCredential_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMicroCredential" ADD CONSTRAINT "UserMicroCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMicroCredential" ADD CONSTRAINT "UserMicroCredential_microCredentialId_fkey" FOREIGN KEY ("microCredentialId") REFERENCES "MicroCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanHandoffRequest" ADD CONSTRAINT "HumanHandoffRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppConversationMessage" ADD CONSTRAINT "WhatsAppConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsAppConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisSubmission" ADD CONSTRAINT "ThesisSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisSubmission" ADD CONSTRAINT "ThesisSubmission_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "AdmissionApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisReviewNote" ADD CONSTRAINT "ThesisReviewNote_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "ThesisSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisTopic" ADD CONSTRAINT "ThesisTopic_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisTopic" ADD CONSTRAINT "ThesisTopic_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisTopic" ADD CONSTRAINT "ThesisTopic_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisTopicRequest" ADD CONSTRAINT "ThesisTopicRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisTopicRequest" ADD CONSTRAINT "ThesisTopicRequest_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThesisTopicRequest" ADD CONSTRAINT "ThesisTopicRequest_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ThesisTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefenseMessage" ADD CONSTRAINT "DefenseMessage_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "ThesisSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentApplication" ADD CONSTRAINT "AgentApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDocument" ADD CONSTRAINT "AgentDocument_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueShareTransaction" ADD CONSTRAINT "RevenueShareTransaction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorVoiceSignal" ADD CONSTRAINT "SupervisorVoiceSignal_callId_fkey" FOREIGN KEY ("callId") REFERENCES "SupervisorVoiceCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorAssessmentQuestion" ADD CONSTRAINT "SupervisorAssessmentQuestion_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "SupervisorAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorAssessmentAttempt" ADD CONSTRAINT "SupervisorAssessmentAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "SupervisorAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorAssessmentAnswer" ADD CONSTRAINT "SupervisorAssessmentAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "SupervisorAssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorAssessmentAnswer" ADD CONSTRAINT "SupervisorAssessmentAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "SupervisorAssessmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Book" ADD CONSTRAINT "Book_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookUploadChunk" ADD CONSTRAINT "BookUploadChunk_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookKnowledgeItem" ADD CONSTRAINT "BookKnowledgeItem_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookKnowledgeItem" ADD CONSTRAINT "BookKnowledgeItem_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBankItem" ADD CONSTRAINT "QuestionBankItem_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramStudyGuide" ADD CONSTRAINT "ProgramStudyGuide_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramAssignment" ADD CONSTRAINT "ProgramAssignment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSubmission" ADD CONSTRAINT "AssignmentSubmission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ProgramAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSubmission" ADD CONSTRAINT "AssignmentSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramExam" ADD CONSTRAINT "ProgramExam_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramQuestion" ADD CONSTRAINT "ProgramQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ProgramExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramExamAttempt" ADD CONSTRAINT "ProgramExamAttempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ProgramExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramExamAttempt" ADD CONSTRAINT "ProgramExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramAnswer" ADD CONSTRAINT "ProgramAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ProgramExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramAnswer" ADD CONSTRAINT "ProgramAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ProgramQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefenseParticipant" ADD CONSTRAINT "DefenseParticipant_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "ThesisSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDocument" ADD CONSTRAINT "AdmissionDocument_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDeliverable" ADD CONSTRAINT "ServiceDeliverable_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

