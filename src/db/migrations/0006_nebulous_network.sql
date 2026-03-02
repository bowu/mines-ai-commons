ALTER TABLE "agent_chat_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD COLUMN "updated_at" timestamp DEFAULT now();