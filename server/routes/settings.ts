import { Router } from "express";
import type { Repositories } from "../db";
import { parse, settingsSchema } from "../validation";

export function createSettingsRouter(repos: Repositories): Router {
  const router = Router();
  router.get("/", async (_req, res) => res.json(await repos.settings.get(res.locals.userId as string)));
  router.put("/", async (req, res) => {
    const input = parse(settingsSchema, req.body);
    res.json(await repos.settings.update(res.locals.userId as string, input));
  });
  return router;
}
