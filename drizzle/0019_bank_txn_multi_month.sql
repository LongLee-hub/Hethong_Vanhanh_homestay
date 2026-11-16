ALTER TABLE "expenses" DROP CONSTRAINT "expenses_bank_transaction_id_unique";--> statement-breakpoint
CREATE INDEX "expenses_bank_txn" ON "expenses" USING btree ("bank_transaction_id");