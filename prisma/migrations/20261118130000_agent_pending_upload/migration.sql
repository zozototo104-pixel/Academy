CREATE TABLE "AgentPendingUpload" (
    "storageKey" TEXT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentPendingUpload_pkey" PRIMARY KEY ("storageKey")
);
