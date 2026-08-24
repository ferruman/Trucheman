import { Router } from "express";
import { profilesView, resolveProfiles } from "../config/profiles.js";
import { DomainError } from "../domain/errors.js";
import { problemResponse } from "./problem.js";

/**
 * Read-only by design: provider configuration comes from the server environment, so there
 * is nothing here for the browser to write. An earlier writable settings.json was never
 * read by the pipeline, which made every value shown in the UI a fiction.
 */
export function settingsRouter() {
  const r = Router();
  r.get("/", (_q, res) => res.json(profilesView()));
  r.post("/test", (_q, res) => {
    const profiles = resolveProfiles();
    if (!profiles.useExternal)
      return problemResponse(
        res,
        new DomainError(
          "credential_missing",
          "No provider credential is configured; runs will use the deterministic local provider",
          400,
        ),
      );
    return res.json({
      ok: true,
      detail:
        "Credentials are configured. A live connection will be verified when processing begins.",
    });
  });
  return r;
}
