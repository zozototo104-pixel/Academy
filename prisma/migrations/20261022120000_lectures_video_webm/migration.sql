-- L6: allow WEBM as a lecture video source (additive enum value only).
ALTER TYPE "LectureVideoSource" ADD VALUE IF NOT EXISTS 'WEBM';
