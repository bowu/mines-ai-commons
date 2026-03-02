INSERT INTO "organizations" ("name", "slug", "domain")
VALUES ('Colorado School of Mines', 'mines', 'mines.edu')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

UPDATE "agents"
SET "org_id" = (
  SELECT "id"
  FROM "organizations"
  WHERE "slug" = 'mines'
)
WHERE "org_id" IS NULL;
--> statement-breakpoint

UPDATE "skills"
SET "org_id" = (
  SELECT "id"
  FROM "organizations"
  WHERE "slug" = 'mines'
)
WHERE "org_id" IS NULL;
