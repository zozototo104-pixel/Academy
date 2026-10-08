-- A database-level invariant: concurrent requests cannot create two active jobs for one book.
-- Completed and failed historical jobs remain allowed.
CREATE UNIQUE INDEX "BookReadJob_one_active_per_book_idx"
  ON "BookReadJob" ("bookId")
  WHERE "status" IN ('QUEUED', 'RUNNING', 'PAUSED');
