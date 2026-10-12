import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../../shared/api";
import { createApp } from "../app";
import type { Database, Repositories } from "../db/types";
import { createTestRepositories } from "../db/testing";
import { ApiError, errorHandler } from "../errors";
import { createMailerFromEnv } from "../mail";
import type { Mailer } from "../mail";
import { DemoProvider } from "../market";
import { createAuthRouter } from "../routes/auth";
import type { AuthRouterOptions } from "../routes/auth";
import { hashPassword, hashToken, SESSION_DURATION_MS, verifyPassword } from "./index";

const EMAIL = "anna@example.com";
const PASSWORD = "ein-sicheres-passwort";
const NEW_PASSWORD = "ein-neues-sicheres-passwort";

describe("Authentifizierung", () => {
  let db: Database;
  let repos: Repositories;
  let close: () => Promise<void>;
  let currentTime: Date;
  let mailer: Mailer;
  let sendPasswordReset: ReturnType<typeof vi.fn<Mailer["sendPasswordReset"]>>;

  beforeEach(async () => {
    ({ db, repos, close } = await createTestRepositories());
    currentTime = new Date("2026-10-11T10:00:00.000Z");
    sendPasswordReset = vi.fn(async () => {});
    mailer = { mode: "console", sendPasswordReset };
  });

  afterEach(async () => {
    await close();
    vi.restoreAllMocks();
  });

  function app(options: Partial<AuthRouterOptions> = {}) {
    const application = express();
    application.use(express.json());
    application.use(cookieParser());
    application.use((req, _res, next) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
        next(new ApiError(403, "FORBIDDEN", "Die Anfrage konnte nicht bestätigt werden."));
        return;
      }
      next();
    });
    application.use("/api/auth", createAuthRouter({
      repos, mailer, now: () => currentTime, production: false,
      appUrl: "http://localhost:5173/", ...options,
    }));
    application.use(errorHandler);
    return application;
  }

  async function register(application: ReturnType<typeof app>, email = EMAIL) {
    return request(application).post("/api/auth/register")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email, password: PASSWORD });
  }

  function cookie(response: { headers: Record<string, unknown> }): string {
    const raw = response.headers["set-cookie"] as string[];
    return raw[0]!.split(";")[0]!;
  }

  async function requestReset(application: ReturnType<typeof app>) {
    return request(application).post("/api/auth/password-reset/request")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: EMAIL });
  }

  function resetToken(): string {
    const resetUrl = sendPasswordReset.mock.calls.at(-1)?.[1];
    expect(resetUrl).toBeDefined();
    return new URL(resetUrl!).searchParams.get("token")!;
  }

  it("registriert, normalisiert E-Mail-Adressen und speichert nur Passwort- und Session-Hashes", async () => {
    const application = app();
    const response = await register(application, "  Anna@Example.com  ");
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: EMAIL, createdAt: currentTime.toISOString() });
    expect(response.body.user.passwordHash).toBeUndefined();
    const storedUser = (await repos.users.findByEmail(EMAIL))!;
    expect(storedUser.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, storedUser.passwordHash)).toBe(true);
    const sessionToken = cookie(response).substring(4);
    expect(Buffer.from(sessionToken, "base64url")).toHaveLength(32);
    const session = (await db.query<{ token_hash: string; expires_at: string }>("SELECT token_hash, expires_at FROM sessions")).rows[0]!;
    expect(session.token_hash).toBe(hashToken(sessionToken));
    expect(session.token_hash).not.toBe(sessionToken);
    expect(session.expires_at).toBe(new Date(currentTime.getTime() + SESSION_DURATION_MS).toISOString());
    expect(response.headers["set-cookie"]![0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]![0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]![0]).not.toContain("Secure");
    const me = await request(application).get("/api/auth/me").set("Cookie", cookie(response));
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(response.body.user);
  });

  it("setzt in Produktion ein Secure-Cookie", async () => {
    const response = await register(app({ production: true }));
    expect(response.status).toBe(201);
    expect(response.headers["set-cookie"]![0]).toContain("Secure");
  });

  it("verwendet unterschiedliche Salts und prüft falsche Passwörter sicher", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(await verifyPassword("falsches-passwort", first)).toBe(false);
    expect(await verifyPassword(PASSWORD, "beschädigter-hash")).toBe(false);
  });

  it("validiert Registrierung und meldet doppelte E-Mail-Adressen als Konflikt", async () => {
    const application = app();
    const invalid = await request(application).post("/api/auth/register")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: "ungueltig", password: "kurz" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalid.body.error.fields).toHaveProperty("email");
    expect(invalid.body.error.fields).toHaveProperty("password");
    await register(application);
    const duplicate = await register(application, "ANNA@EXAMPLE.COM");
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");
    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users")).rows[0]!.count).toBe(1);
  });

  it("registriert dieselbe E-Mail-Adresse bei gleichzeitigen Anfragen genau einmal", async () => {
    const application = app();
    const responses = await Promise.all([
      register(application, EMAIL),
      register(application, "ANNA@EXAMPLE.COM"),
      register(application, "  anna@example.com  "),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409, 409]);
    for (const response of responses.filter(response => response.status === 409)) {
      expect(response.body.error.code).toBe("CONFLICT");
      expect(response.body.error.fields).toHaveProperty("email");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users")).rows[0]!.count).toBe(1);
    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM sessions")).rows[0]!.count).toBe(1);
  });

  it("behandelt einen PostgreSQL-Unique-Konflikt bei der Registrierung als 409", async () => {
    vi.spyOn(repos, "atomic").mockRejectedValueOnce({ code: "23505", detail: "private-database-detail" });
    const response = await register(app());
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.fields).toHaveProperty("email");
    expect(JSON.stringify(response.body)).not.toContain("private-database-detail");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("gibt unerwartete Datenbankfehler ohne interne Details als 500 weiter", async () => {
    vi.spyOn(repos.users, "findByEmail").mockRejectedValueOnce(new Error("private-database-detail"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await register(app());
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("private-database-detail");
  });

  it("erlaubt Login und Logout und widerruft die abgemeldete Session", async () => {
    const application = app();
    await register(application);
    const login = await request(application).post("/api/auth/login")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const sessionCookie = cookie(login);
    expect((await request(application).get("/api/auth/me").set("Cookie", sessionCookie)).status).toBe(200);
    const logout = await request(application).post("/api/auth/logout")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).set("Cookie", sessionCookie);
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]![0]).toContain("sid=;");
    expect((await request(application).get("/api/auth/me").set("Cookie", sessionCookie)).status).toBe(401);
    expect((await request(application).post("/api/auth/logout").set(CSRF_HEADER, CSRF_HEADER_VALUE)).status).toBe(204);
  });

  it("verrät bei falschen Login-Daten nicht, ob die E-Mail-Adresse existiert", async () => {
    const application = app();
    await register(application);
    const wrongPassword = await request(application).post("/api/auth/login")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: EMAIL, password: "falsches-passwort" });
    const unknownEmail = await request(application).post("/api/auth/login")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: "unbekannt@example.com", password: PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
  });

  it("weist fehlende oder abgelaufene Sessions zurück", async () => {
    const application = app();
    expect((await request(application).get("/api/auth/me")).status).toBe(401);
    expect((await request(application).get("/api/auth/me").set("Cookie", "sid=ungueltig")).status).toBe(401);
    const response = await register(application);
    currentTime = new Date(currentTime.getTime() + SESSION_DURATION_MS - 1);
    expect((await request(application).get("/api/auth/me").set("Cookie", cookie(response))).status).toBe(200);
    currentTime = new Date(currentTime.getTime() + 1);
    expect((await request(application).get("/api/auth/me").set("Cookie", cookie(response))).status).toBe(401);
  });

  it("weist schreibende Auth-Anfragen ohne CSRF-Header zurück", async () => {
    const response = await request(app()).post("/api/auth/register").send({ email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users")).rows[0]!.count).toBe(0);
  });

  it("setzt das Passwort genau einmal zurück und beendet alle bestehenden Sessions", async () => {
    const application = app();
    const registration = await register(application);
    const login = await request(application).post("/api/auth/login")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: EMAIL, password: PASSWORD });
    expect((await requestReset(application)).status).toBe(202);
    const token = resetToken();
    expect(sendPasswordReset.mock.calls[0]).toEqual([EMAIL, `http://localhost:5173/passwort-zuruecksetzen?token=${token}`]);
    const storedReset = (await db.query<{ token_hash: string; expires_at: string }>("SELECT token_hash, expires_at FROM password_resets")).rows[0]!;
    expect(storedReset.token_hash).toBe(hashToken(token));
    expect(storedReset.token_hash).not.toBe(token);
    expect(storedReset.expires_at).toBe("2026-10-11T11:00:00.000Z");
    const confirmed = await request(application).post("/api/auth/password-reset/confirm")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ token, password: NEW_PASSWORD });
    expect(confirmed.status).toBe(204);
    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM sessions")).rows[0]!.count).toBe(0);
    expect((await request(application).get("/api/auth/me").set("Cookie", cookie(registration))).status).toBe(401);
    expect((await request(application).get("/api/auth/me").set("Cookie", cookie(login))).status).toBe(401);
    const repeated = await request(application).post("/api/auth/password-reset/confirm")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ token, password: NEW_PASSWORD });
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.fields).toHaveProperty("token");
    expect((await request(application).post("/api/auth/login").set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({ email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await request(application).post("/api/auth/login").set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({ email: EMAIL, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("verhindert die gleichzeitige doppelte Verwendung eines Reset-Tokens", async () => {
    const application = app();
    await register(application);
    await requestReset(application);
    const token = resetToken();
    const responses = await Promise.all([NEW_PASSWORD, `${NEW_PASSWORD}-2`].map(password =>
      request(application).post("/api/auth/password-reset/confirm")
        .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ token, password })));
    expect(responses.map(response => response.status).sort()).toEqual([204, 400]);
  });

  it("weist Reset-Tokens nach 60 Minuten zurück und verändert das Passwort nicht", async () => {
    const application = app();
    await register(application);
    await requestReset(application);
    const token = resetToken();
    currentTime = new Date(currentTime.getTime() + 60 * 60 * 1000);
    const response = await request(application).post("/api/auth/password-reset/confirm")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(400);
    expect(await verifyPassword(PASSWORD, (await repos.users.findByEmail(EMAIL))!.passwordHash)).toBe(true);
  });

  it("antwortet auf Reset-Anfragen immer mit 202, auch für unbekannte oder ungültige E-Mails und bei Limit", async () => {
    const application = app({ rateLimits: { resetRequest: { maxAttempts: 1, windowMs: 60_000 } } });
    await register(application);
    expect((await requestReset(application)).status).toBe(202);
    expect((await requestReset(application)).status).toBe(202);
    expect((await request(application).post("/api/auth/password-reset/request")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: "unbekannt@example.com" })).status).toBe(202);
    expect((await request(application).post("/api/auth/password-reset/request")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: "ungueltig" })).status).toBe(202);
    expect(sendPasswordReset).toHaveBeenCalledTimes(1);
  });

  it("verrät auch Versandfehler bei Passwort-Reset nicht", async () => {
    const application = app();
    await register(application);
    sendPasswordReset.mockRejectedValueOnce(new Error("SMTP nicht erreichbar"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await requestReset(application)).status).toBe(202);
    expect(log).toHaveBeenCalledWith("Die Passwort-Reset-E-Mail konnte nicht versendet werden.");
  });

  it("antwortet für vorhandene Konten mit 202, während der E-Mail-Versand noch läuft", async () => {
    let finishDelivery!: () => void;
    let deliveryFinished = false;
    const pendingDelivery = new Promise<void>(resolve => { finishDelivery = resolve; })
      .then(() => { deliveryFinished = true; });
    sendPasswordReset.mockReturnValueOnce(pendingDelivery);
    const application = app();
    await register(application);
    const response = await request(application).post("/api/auth/password-reset/request")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).send({ email: EMAIL }).timeout({ response: 1000 });
    expect(response.status).toBe(202);
    expect(sendPasswordReset).toHaveBeenCalledTimes(1);
    expect(deliveryFinished).toBe(false);
    expect(resetToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    finishDelivery();
    await pendingDelivery;
  });

  it("antwortet auch bei synchronen Mailer-Fehlern mit 202", async () => {
    const application = app();
    await register(application);
    sendPasswordReset.mockImplementationOnce(() => { throw new Error("Versand konnte nicht gestartet werden"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await requestReset(application)).status).toBe(202);
    expect(log).toHaveBeenCalledWith("Die Passwort-Reset-E-Mail konnte nicht versendet werden.");
  });

  it("begrenzt Registrierung und Login unabhängig und gibt das Limit nach dem Zeitfenster frei", async () => {
    const application = app({ rateLimits: {
      register: { maxAttempts: 1, windowMs: 60_000 },
      login: { maxAttempts: 1, windowMs: 60_000 },
    } });
    expect((await register(application)).status).toBe(201);
    const limitedRegister = await register(application, "zweite@example.com");
    expect(limitedRegister.status).toBe(429);
    expect(limitedRegister.body.error.code).toBe("RATE_LIMITED");
    expect((await request(application).post("/api/auth/login").set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({ email: EMAIL, password: "falsches-passwort" })).status).toBe(401);
    expect((await request(application).post("/api/auth/login").set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({ email: EMAIL, password: PASSWORD })).status).toBe(429);
    currentTime = new Date(currentTime.getTime() + 60_000);
    expect((await request(application).post("/api/auth/login").set(CSRF_HEADER, CSRF_HEADER_VALUE)
      .send({ email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it("begrenzt hinter einem vertrauenswürdigen Proxy jede X-Forwarded-For-Adresse getrennt", async () => {
    const now = () => currentTime;
    const application = createApp({
      repos, market: new DemoProvider({ now }), mailer, now, production: false, trustProxy: 1,
      rateLimits: { register: { maxAttempts: 1, windowMs: 60_000 } },
    });
    const forwardedRegister = (email: string, address: string) => request(application).post("/api/auth/register")
      .set(CSRF_HEADER, CSRF_HEADER_VALUE).set("X-Forwarded-For", address).send({ email, password: PASSWORD });
    expect((await forwardedRegister("erste@example.com", "203.0.113.1")).status).toBe(201);
    const firstLimited = await forwardedRegister("erste-weitere@example.com", "203.0.113.1");
    expect(firstLimited.status).toBe(429);
    expect(firstLimited.body.error.code).toBe("RATE_LIMITED");
    expect((await forwardedRegister("zweite@example.com", "203.0.113.2")).status).toBe(201);
    expect((await forwardedRegister("zweite-weitere@example.com", "203.0.113.2")).status).toBe(429);
  });

  it("kennzeichnet den Console-Mailer ausdrücklich als lokalen Modus", async () => {
    const localMailer = createMailerFromEnv({ SMTP_HOST: "" });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(localMailer.mode).toBe("console");
    await localMailer.sendPasswordReset(EMAIL, "http://localhost/reset?token=demo");
    expect(log.mock.calls[0]![0]).toContain("LOKALER MODUS – KEIN E-MAIL-VERSAND");
    expect(log.mock.calls[0]![0]).toContain("http://localhost/reset?token=demo");
    expect(createMailerFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465" }).mode).toBe("smtp");
  });
});
