CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" uuid,
	CONSTRAINT "notes_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "notes_title_chk" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "notes_content_chk" CHECK (char_length(content) BETWEEN 1 AND 20000),
	CONSTRAINT "notes_summary_min_content_chk" CHECK (summary IS NULL OR char_length(content) >= 500),
	CONSTRAINT "notes_summary_length_chk" CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 590),
	CONSTRAINT "notes_summary_shorter_chk" CHECK (summary IS NULL OR char_length(summary) < char_length(content)),
	CONSTRAINT "notes_tags_count_chk" CHECK (cardinality(tags) BETWEEN 1 AND 5),
	CONSTRAINT "notes_tags_length_chk" CHECK (tags IS NULL OR (tags[1] IS NOT NULL AND char_length(tags[1]) BETWEEN 1 AND 40 AND (tags[2] IS NULL OR char_length(tags[2]) BETWEEN 1 AND 40) AND (tags[3] IS NULL OR char_length(tags[3]) BETWEEN 1 AND 40) AND (tags[4] IS NULL OR char_length(tags[4]) BETWEEN 1 AND 40) AND (tags[5] IS NULL OR char_length(tags[5]) BETWEEN 1 AND 40)))
);
--> statement-breakpoint
CREATE INDEX "notes_created_at_idx" ON "notes" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);