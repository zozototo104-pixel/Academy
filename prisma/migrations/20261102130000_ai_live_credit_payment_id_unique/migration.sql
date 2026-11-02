-- A purchase payment may grant live-voice minutes exactly once. The grant
-- path already serializes on the payment row and re-checks for an existing
-- credit; this unique index makes double-granting impossible at the
-- database level as well. NULL paymentId rows (admin grants, refunds) are
-- unaffected: Postgres treats NULLs as distinct in a unique index.
CREATE UNIQUE INDEX "AiLiveCredit_paymentId_key" ON "AiLiveCredit"("paymentId");
