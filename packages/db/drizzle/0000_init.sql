CREATE TYPE "public"."auth_provider" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."bot_level" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."game_shelf" AS ENUM('friends', 'adventure', 'relax');--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('live', 'coming_soon', 'disabled', 'dev');--> statement-breakpoint
CREATE TYPE "public"."match_action_kind" AS ENUM('action', 'timeout', 'tick', 'effect', 'clock');--> statement-breakpoint
CREATE TYPE "public"."match_outcome" AS ENUM('win', 'loss', 'draw', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('android', 'web');--> statement-breakpoint
CREATE TYPE "public"."quiz_pack" AS ENUM('online', 'practice');--> statement-breakpoint
CREATE TYPE "public"."quiz_question_status" AS ENUM('approved', 'needs_review', 'retired');--> statement-breakpoint
CREATE TYPE "public"."quiz_text_status" AS ENUM('approved', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('LOBBY', 'IN_PROGRESS', 'FINISHED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."user_kind" AS ENUM('guest', 'google');--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_sub" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_pk" PRIMARY KEY("provider","provider_sub")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"app_version" text,
	"push_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "devices_push_token_uq" UNIQUE("push_token")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_token_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "user_kind" DEFAULT 'guest' NOT NULL,
	"guest_key_hash" text,
	"display_name" text NOT NULL,
	"avatar_seed" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"mute_invites" boolean DEFAULT false NOT NULL,
	"merged_into_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_releases" (
	"platform" "platform" NOT NULL,
	"version" text NOT NULL,
	"runtime_version" text NOT NULL,
	"apk_url" text,
	"min_supported" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_releases_pk" PRIMARY KEY("platform","version")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"shelf" "game_shelf" NOT NULL,
	"status" "game_status" DEFAULT 'coming_soon' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort" integer NOT NULL,
	"min_app_version" text DEFAULT '0.0.0' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_state_single_row" CHECK ("server_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "room_seats" (
	"room_id" uuid NOT NULL,
	"seat" smallint NOT NULL,
	"user_id" uuid,
	"bot_level" "bot_level",
	"team" smallint,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_seats_pk" PRIMARY KEY("room_id","seat"),
	CONSTRAINT "room_seats_seat_range" CHECK ("room_seats"."seat" BETWEEN 0 AND 7)
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"game_id" text NOT NULL,
	"mode" text NOT NULL,
	"host_user_id" uuid NOT NULL,
	"seat_count" smallint NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "room_status" DEFAULT 'LOBBY' NOT NULL,
	"owner_epoch" bigint NOT NULL,
	"released_at" timestamp with time zone,
	"last_write_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"kicked_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "rooms_seat_count_range" CHECK ("rooms"."seat_count" BETWEEN 1 AND 8),
	CONSTRAINT "rooms_code_format" CHECK ("rooms"."code" ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$')
);
--> statement-breakpoint
CREATE TABLE "match_actions" (
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "match_action_kind" NOT NULL,
	"seat" smallint,
	"payload" jsonb NOT NULL,
	"game_now" bigint NOT NULL,
	"server_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"client_action_id" text,
	CONSTRAINT "match_actions_pk" PRIMARY KEY("match_id","seq"),
	CONSTRAINT "match_actions_client_action_uq" UNIQUE("match_id","seat","client_action_id")
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"match_id" uuid NOT NULL,
	"seat" smallint NOT NULL,
	"user_id" uuid,
	"bot_level" "bot_level",
	"team" smallint,
	"outcome" "match_outcome",
	"score" integer,
	"stats" jsonb,
	CONSTRAINT "match_participants_pk" PRIMARY KEY("match_id","seat")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"mode" text NOT NULL,
	"seed" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logic_version" integer NOT NULL,
	"state_version" integer NOT NULL,
	"snapshot" jsonb,
	"snapshot_version" bigint DEFAULT 0 NOT NULL,
	"result" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_game_stats" (
	"user_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"mode" text DEFAULT 'default' NOT NULL,
	"played" integer DEFAULT 0 NOT NULL,
	"won" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"drawn" integer DEFAULT 0 NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"best" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_game_stats_pk" PRIMARY KEY("user_id","game_id","mode")
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"game_id" text,
	"ref_id" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hlc" jsonb NOT NULL,
	"device_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "progress_ledger" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"key" text NOT NULL,
	"delta" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recent_players" (
	"user_id" uuid NOT NULL,
	"other_user_id" uuid NOT NULL,
	"last_played_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recent_players_pk" PRIMARY KEY("user_id","other_user_id"),
	CONSTRAINT "recent_players_not_self" CHECK ("recent_players"."user_id" <> "recent_players"."other_user_id")
);
--> statement-breakpoint
CREATE TABLE "save_slots" (
	"user_id" uuid NOT NULL,
	"game_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"hlc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "save_slots_pk" PRIMARY KEY("user_id","game_id")
);
--> statement-breakpoint
CREATE TABLE "quiz_question_text" (
	"question_id" text NOT NULL,
	"lang" text NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"status" "quiz_text_status" DEFAULT 'needs_review' NOT NULL,
	CONSTRAINT "quiz_question_text_pk" PRIMARY KEY("question_id","lang")
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"difficulty" smallint NOT NULL,
	"answer_idx" smallint NOT NULL,
	"source" text NOT NULL,
	"as_of" date,
	"status" "quiz_question_status" DEFAULT 'approved' NOT NULL,
	"pack" "quiz_pack" DEFAULT 'online' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_questions_difficulty_range" CHECK ("quiz_questions"."difficulty" BETWEEN 1 AND 3),
	CONSTRAINT "quiz_questions_answer_nonnegative" CHECK ("quiz_questions"."answer_idx" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quiz_reports" (
	"question_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_reports_pk" PRIMARY KEY("question_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "quiz_seen" (
	"user_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_seen_pk" PRIMARY KEY("user_id","question_id")
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_merged_into_user_id_users_id_fk" FOREIGN KEY ("merged_into_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_seats" ADD CONSTRAINT "room_seats_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_seats" ADD CONSTRAINT "room_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_actions" ADD CONSTRAINT "match_actions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_game_stats" ADD CONSTRAINT "user_game_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_ledger" ADD CONSTRAINT "progress_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_players" ADD CONSTRAINT "recent_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_players" ADD CONSTRAINT "recent_players_other_user_id_users_id_fk" FOREIGN KEY ("other_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "save_slots" ADD CONSTRAINT "save_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_question_text" ADD CONSTRAINT "quiz_question_text_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_reports" ADD CONSTRAINT "quiz_reports_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_reports" ADD CONSTRAINT "quiz_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_seen" ADD CONSTRAINT "quiz_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_seen" ADD CONSTRAINT "quiz_seen_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_guest_key_hash_uq" ON "users" USING btree ("guest_key_hash") WHERE "users"."guest_key_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_merged_into_idx" ON "users" USING btree ("merged_into_user_id") WHERE "users"."merged_into_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "room_seats_room_user_uq" ON "room_seats" USING btree ("room_id","user_id") WHERE "room_seats"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "room_seats_user_idx" ON "room_seats" USING btree ("user_id") WHERE "room_seats"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_open_code_uq" ON "rooms" USING btree ("code") WHERE "rooms"."status" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "rooms_code_idx" ON "rooms" USING btree ("code");--> statement-breakpoint
CREATE INDEX "rooms_open_expires_idx" ON "rooms" USING btree ("expires_at") WHERE "rooms"."status" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "rooms_host_status_idx" ON "rooms" USING btree ("host_user_id","status");--> statement-breakpoint
CREATE INDEX "match_actions_server_ts_idx" ON "match_actions" USING btree ("server_ts");--> statement-breakpoint
CREATE INDEX "match_participants_user_idx" ON "match_participants" USING btree ("user_id","match_id") WHERE "match_participants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "matches_room_idx" ON "matches" USING btree ("room_id","started_at");--> statement-breakpoint
CREATE INDEX "matches_unfinished_idx" ON "matches" USING btree ("room_id") WHERE "matches"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "activity_user_created_idx" ON "activity" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "progress_events_user_game_idx" ON "progress_events" USING btree ("user_id","game_id");--> statement-breakpoint
CREATE INDEX "progress_events_applied_idx" ON "progress_events" USING btree ("applied_at");--> statement-breakpoint
CREATE INDEX "progress_ledger_balance_idx" ON "progress_ledger" USING btree ("user_id","game_id","key");--> statement-breakpoint
CREATE INDEX "recent_players_user_recent_idx" ON "recent_players" USING btree ("user_id","last_played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quiz_questions_pick_idx" ON "quiz_questions" USING btree ("pack","category","status");--> statement-breakpoint
CREATE INDEX "quiz_seen_seen_at_idx" ON "quiz_seen" USING btree ("seen_at");