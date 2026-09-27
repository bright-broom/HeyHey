CREATE TABLE "activity_snapshots" (
	"day" date PRIMARY KEY NOT NULL,
	"active_members" integer NOT NULL,
	"weekly_active_members" integer NOT NULL,
	"posts_week" integer NOT NULL,
	"comments_week" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
