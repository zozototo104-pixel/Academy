-- Normalize and enforce unique USDT transaction hashes so one blockchain transaction cannot be reused for multiple invoices.
UPDATE "Payment"
SET "cryptoTxHash" = NULL
WHERE "cryptoTxHash" IS NOT NULL AND btrim("cryptoTxHash") = '';

UPDATE "Payment"
SET "cryptoTxHash" = lower(regexp_replace(btrim("cryptoTxHash"), '^0x', '', 'i'))
WHERE "cryptoTxHash" IS NOT NULL;

CREATE UNIQUE INDEX "Payment_cryptoTxHash_key" ON "Payment"("cryptoTxHash");
