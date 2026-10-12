ALTER TABLE "notes" DROP CONSTRAINT "notes_content_chk";--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_content_chk" CHECK (char_length(content) BETWEEN 1 AND 50000);