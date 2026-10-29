-- المحاضر لكل لقاء (2026-10-29): كل لقاء قد يكون له محاضر خاص يختلف عن
-- مشرف السلسلة؛ فارغ = يتبع مشرف السلسلة (سلوك كل اللقاءات القائمة).
ALTER TABLE "LectureSession" ADD COLUMN "lecturerId" TEXT;
CREATE INDEX "LectureSession_lecturerId_idx" ON "LectureSession"("lecturerId");
ALTER TABLE "LectureSession" ADD CONSTRAINT "LectureSession_lecturerId_fkey" FOREIGN KEY ("lecturerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
