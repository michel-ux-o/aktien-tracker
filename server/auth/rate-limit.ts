import type { RequestHandler } from "express";
import { ApiError } from "../errors";

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
}

interface Counter {
  count: number;
  expiresAt: number;
}

export class MemoryRateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly options: RateLimitOptions, private readonly now: () => Date) {}

  allow(key: string): boolean {
    const currentTime = this.now().getTime();
    // Also remove inactive entries, so the map does not retain every historical IP.
    for (const [storedKey, counter] of this.counters) {
      if (counter.expiresAt <= currentTime) this.counters.delete(storedKey);
    }
    const counter = this.counters.get(key);
    if (!counter) {
      this.counters.set(key, { count: 1, expiresAt: currentTime + this.options.windowMs });
      return this.options.maxAttempts > 0;
    }
    counter.count += 1;
    return counter.count <= this.options.maxAttempts;
  }

  middleware(): RequestHandler {
    return (req, _res, next) => {
      if (!this.allow(req.ip ?? req.socket.remoteAddress ?? "unknown")) {
        next(new ApiError(429, "RATE_LIMITED", "Zu viele Versuche. Bitte versuchen Sie es später erneut."));
        return;
      }
      next();
    };
  }
}
