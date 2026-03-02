import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { clearCoreTables, closeTestPool } from "../test/db-helper.js";

const app = createApp();

describe("skills routes integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("supports skills CRUD flow", async () => {
    const listEmpty = await request(app).get("/api/skills");
    expect(listEmpty.status).toBe(200);
    expect(listEmpty.body.skills).toEqual([]);

    const create = await request(app)
      .post("/api/skills")
      .field("name", "Integration Skill")
      .field("description", "skill for integration tests")
      .field("when_to_use", "during integration testing")
      .field("instructions", "run assertions")
      .field("tool_type", "web_search");

    expect(create.status).toBe(201);
    const skillId = create.body.skill.id as string;
    expect(create.body.skill.name).toBe("Integration Skill");

    const getOne = await request(app).get(`/api/skills/${skillId}`);
    expect(getOne.status).toBe(200);
    expect(getOne.body.skill.id).toBe(skillId);

    const update = await request(app)
      .put(`/api/skills/${skillId}`)
      .field("description", "updated description");
    expect(update.status).toBe(200);
    expect(update.body.skill.description).toBe("updated description");

    const del = await request(app).delete(`/api/skills/${skillId}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });
});
