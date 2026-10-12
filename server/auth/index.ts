import type { RequestHandler } from "express";
import type { User } from "../../shared/types";
import type { Repositories, StoredUser } from "../db";
import { ApiError } from "../errors";
import { hashToken, isToken } from "./tokens";

export { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "./passwords";
export { createToken, hashToken, isToken } from "./tokens";
export { MemoryRateLimiter } from "./rate-limit";
export type { RateLimitOptions } from "./rate-limit";

export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const RESET_DURATION_MS = 60 * 60 * 1000;

export function publicUser(user: StoredUser): User {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function requireAuth({ repos, now }: { repos: Repositories; now: () => Date }): RequestHandler {
  return async (req, res, next) => {
    const token: unknown = req.cookies?.sid;
    const session = isToken(token) ? await repos.sessions.findValid(hashToken(token), now().toISOString()) : undefined;
    const user = session ? await repos.users.findById(session.userId) : undefined;
    if (!session || !user) {
      next(new ApiError(401, "UNAUTHENTICATED", "Bitte melden Sie sich an."));
      return;
    }
    res.locals.userId = session.userId;
    res.locals.user = publicUser(user);
    next();
  };
}
