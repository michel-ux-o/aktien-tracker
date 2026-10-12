import { Router } from "express";
import type { CookieOptions, Response } from "express";
import { z } from "zod";
import {
  createToken, DUMMY_PASSWORD_HASH, hashPassword, hashToken, isToken,
  MemoryRateLimiter, publicUser, requireAuth, RESET_DURATION_MS,
  SESSION_DURATION_MS, verifyPassword,
} from "../auth";
import type { RateLimitOptions } from "../auth";
import type { Repositories, StoredUser } from "../db";
import { ApiError, isUniqueViolation } from "../errors";
import type { Mailer } from "../mail";

const emailSchema = z.string({ error: "Bitte geben Sie eine E-Mail-Adresse an." })
  .trim().toLowerCase().max(254, "Die E-Mail-Adresse ist zu lang.")
  .email("Bitte geben Sie eine gültige E-Mail-Adresse an.");
const newPasswordSchema = z.string({ error: "Bitte geben Sie ein Passwort an." })
  .min(10, "Das Passwort muss mindestens 10 Zeichen lang sein.")
  .max(1024, "Das Passwort darf höchstens 1024 Zeichen lang sein.");
const bodyError = { error: "Bitte senden Sie eine gültige JSON-Anfrage." };
const registrationSchema = z.object({ email: emailSchema, password: newPasswordSchema }, bodyError);
const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ error: "Bitte geben Sie ein Passwort an." })
    .min(1, "Bitte geben Sie ein Passwort an.").max(1024, "Das Passwort ist zu lang."),
}, bodyError);
const resetRequestSchema = z.object({ email: emailSchema }, bodyError);
const resetConfirmSchema = z.object({
  token: z.string({ error: "Der Reset-Link ist ungültig oder abgelaufen." })
    .refine(isToken, "Der Reset-Link ist ungültig oder abgelaufen."),
  password: newPasswordSchema,
}, bodyError);

function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body, { error: () => "Dieses Feld enthält einen ungültigen Wert." });
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    fields[String(issue.path[0] ?? "body")] ??= issue.message;
  }
  throw new ApiError(400, "VALIDATION_ERROR", "Bitte prüfen Sie Ihre Eingaben.", fields);
}

type LimitedRoute = "register" | "login" | "resetRequest" | "resetConfirm";

export interface AuthRouterOptions {
  repos: Repositories;
  mailer: Mailer;
  now: () => Date;
  production: boolean;
  appUrl: string;
  rateLimits?: Partial<Record<LimitedRoute, RateLimitOptions>>;
}

export function createAuthRouter({ repos, mailer, now, production, appUrl, rateLimits = {} }: AuthRouterOptions) {
  const router = Router();
  const defaults: Record<LimitedRoute, RateLimitOptions> = {
    register: { maxAttempts: 10, windowMs: 60 * 60 * 1000 },
    login: { maxAttempts: 20, windowMs: 15 * 60 * 1000 },
    resetRequest: { maxAttempts: 10, windowMs: 60 * 60 * 1000 },
    resetConfirm: { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
  };
  const limiter = (route: LimitedRoute) => new MemoryRateLimiter(rateLimits[route] ?? defaults[route], now);
  const registerLimiter = limiter("register");
  const loginLimiter = limiter("login");
  const resetRequestLimiter = limiter("resetRequest");
  const resetConfirmLimiter = limiter("resetConfirm");
  const cookieOptions: CookieOptions = { httpOnly: true, sameSite: "lax", secure: production, path: "/" };

  async function createSession(user: StoredUser, sessionRepos = repos): Promise<string> {
    const token = createToken();
    const currentTime = now();
    await sessionRepos.sessions.create(user.id, hashToken(token), new Date(currentTime.getTime() + SESSION_DURATION_MS).toISOString(), currentTime.toISOString());
    return token;
  }

  function setSessionCookie(token: string, res: Response): void {
    res.cookie("sid", token, { ...cookieOptions, maxAge: SESSION_DURATION_MS });
  }

  function registrationConflict(): ApiError {
    return new ApiError(409, "CONFLICT", "Diese E-Mail-Adresse ist bereits registriert.", { email: "Diese E-Mail-Adresse ist bereits registriert." });
  }

  router.post("/register", registerLimiter.middleware(), async (req, res) => {
    const input = parseInput(registrationSchema, req.body);
    if (await repos.users.findByEmail(input.email)) {
      throw registrationConflict();
    }
    const passwordHash = await hashPassword(input.password);
    let user: StoredUser;
    try {
      user = await repos.atomic(async (tx) => {
        // A concurrent registration can complete while scrypt is running.
        if (await tx.users.findByEmail(input.email)) throw registrationConflict();
        return tx.users.create(input.email, passwordHash, now().toISOString());
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw registrationConflict();
      throw error;
    }
    setSessionCookie(await createSession(user), res);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post("/login", loginLimiter.middleware(), async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    const user = await repos.users.findByEmail(input.email);
    const validPassword = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    // A password reset may have completed while the asynchronous derivation ran.
    if (!user || !validPassword) {
      throw new ApiError(401, "UNAUTHENTICATED", "E-Mail-Adresse oder Passwort ist falsch.");
    }
    const token = await repos.atomic(async (tx) => {
      // Serialize session creation with password resets for this user.
      if ((await tx.users.findById(user.id))?.passwordHash !== user.passwordHash) {
        throw new ApiError(401, "UNAUTHENTICATED", "E-Mail-Adresse oder Passwort ist falsch.");
      }
      return createSession(user, tx);
    }, { lockKey: user.id });
    setSessionCookie(token, res);
    res.json({ user: publicUser(user) });
  });

  router.post("/logout", async (req, res) => {
    const token: unknown = req.cookies?.sid;
    if (isToken(token)) await repos.sessions.delete(hashToken(token));
    res.clearCookie("sid", cookieOptions);
    res.status(204).end();
  });

  router.get("/me", requireAuth({ repos, now }), (_req, res) => {
    res.json({ user: res.locals.user });
  });

  router.post("/password-reset/request", async (req, res) => {
    const allowed = resetRequestLimiter.allow(req.ip ?? req.socket.remoteAddress ?? "unknown");
    const parsed = resetRequestSchema.safeParse(req.body);
    const user = allowed && parsed.success ? await repos.users.findByEmail(parsed.data.email) : undefined;
    if (user) {
      const token = createToken();
      const currentTime = now();
      await repos.passwordResets.create(user.id, hashToken(token), new Date(currentTime.getTime() + RESET_DURATION_MS).toISOString(), currentTime.toISOString());
      const resetUrl = `${appUrl.replace(/\/+$/, "")}/passwort-zuruecksetzen?token=${encodeURIComponent(token)}`;
      const reportMailFailure = () => {
        // Do not expose account existence or mail-service failures to the requester.
        console.error("Die Passwort-Reset-E-Mail konnte nicht versendet werden.");
      };
      try {
        // Start delivery immediately for injectable mailers, but do not let SMTP
        // latency disclose whether an account exists through response timing.
        void mailer.sendPasswordReset(user.email, resetUrl).catch(reportMailFailure);
      } catch {
        reportMailFailure();
      }
    }
    res.status(202).end();
  });

  router.post("/password-reset/confirm", resetConfirmLimiter.middleware(), async (req, res) => {
    const input = parseInput(resetConfirmSchema, req.body);
    const tokenHash = hashToken(input.token);
    const existingReset = await repos.passwordResets.findValid(tokenHash, now().toISOString());
    if (!existingReset) {
      throw new ApiError(400, "VALIDATION_ERROR", "Der Reset-Link ist ungültig oder abgelaufen.", { token: "Der Reset-Link ist ungültig oder abgelaufen." });
    }
    const passwordHash = await hashPassword(input.password);
    await repos.atomic(async (tx) => {
      const reset = await tx.passwordResets.findValid(tokenHash, now().toISOString());
      if (!reset || !await tx.passwordResets.consume(tokenHash) || !await tx.users.updatePassword(reset.userId, passwordHash)) {
        throw new ApiError(400, "VALIDATION_ERROR", "Der Reset-Link ist ungültig oder abgelaufen.", { token: "Der Reset-Link ist ungültig oder abgelaufen." });
      }
      await tx.sessions.deleteForUser(reset.userId);
    }, { lockKey: existingReset.userId });
    res.clearCookie("sid", cookieOptions);
    res.status(204).end();
  });

  return router;
}
