import { Router } from "express";
import { z } from "zod";
import { settingsSchema, type SettingsRepository } from "../storage/settings-repository.js";
import { DomainError } from "../domain/errors.js";
import { problemResponse } from "./problem.js";
const updateSchema = settingsSchema
  .partial()
  .extend({
    translation: settingsSchema.shape.translation.partial().optional(),
    editing: settingsSchema.shape.editing.partial().optional(),
  })
  .strict();
export function settingsRouter(repo: SettingsRepository) {
  const r = Router();
  r.get("/", async (_q, res) => res.json(await repo.get()));
  r.put("/", async (req, res) => {
    try {
      const old = await repo.get(),
        parsed = updateSchema.parse(req.body);
      const next = settingsSchema.parse({
        ...old,
        ...parsed,
        translation: {
          ...old.translation,
          ...parsed.translation,
          hasApiKey: old.translation.hasApiKey,
        },
        editing: { ...old.editing, ...parsed.editing, hasApiKey: old.editing.hasApiKey },
      });
      await repo.save(next);
      res.json(next);
    } catch (error) {
      problemResponse(
        res,
        error instanceof z.ZodError
          ? new DomainError("invalid_settings", error.issues[0]?.message ?? "Invalid settings", 400)
          : error,
        req,
      );
    }
  });
  r.post("/test", async (_q, res) => {
    const settings = await repo.get();
    if (!settings.translation.hasApiKey && !settings.editing.hasApiKey)
      return problemResponse(
        res,
        new DomainError("credential_missing", "No provider credential is configured", 400),
      );
    return res.json({
      ok: true,
      detail:
        "Credentials are configured. A live connection will be verified when processing begins.",
    });
  });
  return r;
}
