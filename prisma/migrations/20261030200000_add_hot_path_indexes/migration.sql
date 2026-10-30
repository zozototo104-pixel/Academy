-- فهارس بحث للمسارات الساخنة (تدقيق ٢٠٢٦-١٠-٣٠، الوحدة ٩).
-- ستة جداول مركزية كانت بلا أي فهرس ثانوي: كل استعلام عليها مسح كامل.
-- إضافة فقط — لا تغيير ببيانات ولا سلوك، والحذف يعكسها بالكامل.

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_userId_status_idx" ON "Payment"("userId", "status");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_examId_status_idx" ON "ExamAttempt"("userId", "examId", "status");

-- CreateIndex
CREATE INDEX "ProgramExamAttempt_userId_examId_status_idx" ON "ProgramExamAttempt"("userId", "examId", "status");

-- CreateIndex
CREATE INDEX "AdmissionApplication_status_createdAt_idx" ON "AdmissionApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionApplication_supervisorId_idx" ON "AdmissionApplication"("supervisorId");

-- CreateIndex
CREATE INDEX "AdmissionApplication_userId_idx" ON "AdmissionApplication"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");
