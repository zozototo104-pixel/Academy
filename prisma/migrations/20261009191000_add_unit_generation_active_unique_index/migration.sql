CREATE UNIQUE INDEX "UnitGenerationJob_active_unitId_key"
ON "UnitGenerationJob" ("unitId")
WHERE "status" IN ('QUEUED', 'RUNNING');
