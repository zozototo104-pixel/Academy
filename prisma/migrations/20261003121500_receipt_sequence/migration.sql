-- Make receipt numbers concurrency-safe.
-- If historical duplicate receipt numbers exist, preserve the first one and suffix later duplicates before adding the unique index.
WITH ranked AS (
  SELECT
    "id",
    "receiptNo",
    ROW_NUMBER() OVER (PARTITION BY "receiptNo" ORDER BY "paidAt" NULLS LAST, "createdAt", "id") AS rn
  FROM "Payment"
  WHERE "receiptNo" IS NOT NULL
)
UPDATE "Payment" p
SET "receiptNo" = ranked."receiptNo" || '-DUP-' || substring(p."id" from 1 for 6)
FROM ranked
WHERE p."id" = ranked."id" AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_receiptNo_key" ON "Payment"("receiptNo");

CREATE SEQUENCE IF NOT EXISTS payment_receipt_no_seq;

SELECT setval(
  'payment_receipt_no_seq',
  GREATEST(
    1,
    COALESCE((
      SELECT MAX((substring("receiptNo" from 'AACT-REC-[0-9]{4}-([0-9]+)'))::bigint)
      FROM "Payment"
      WHERE "receiptNo" ~ '^AACT-REC-[0-9]{4}-[0-9]+$'
    ), 0) + 1
  ),
  false
);
