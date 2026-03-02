INSERT INTO "users" ("org_id", "email", "name", "role")
SELECT "o"."id", 'admin@mines.edu', 'Default Admin', 'admin'
FROM "organizations" "o"
WHERE "o"."slug" = 'mines'
ON CONFLICT ((LOWER("email"))) DO NOTHING;
--> statement-breakpoint

INSERT INTO "agent_access" ("agent_id", "user_id", "role")
SELECT "a"."id", "u"."id", 'owner'
FROM "agents" "a"
JOIN "users" "u" ON LOWER("u"."email") = 'admin@mines.edu'
ON CONFLICT ("agent_id", "user_id") DO NOTHING;
