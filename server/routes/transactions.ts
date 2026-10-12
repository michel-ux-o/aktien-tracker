import { Router } from "express";
import { z } from "zod";
import { MAX_IMPORT_TRANSACTIONS, type ImportTransactionsResponse } from "../../shared/api";
import { validateTransactionInput, validateTransactionSequence } from "../../shared/portfolio";
import type { Transaction, TransactionInput } from "../../shared/types";
import type { Repositories } from "../db";
import { ApiError, isUniqueViolation } from "../errors";
import { instrumentIdSchema, parse } from "../validation";

interface TransactionsDependencies {
  repos: Repositories;
  now: () => Date;
}

const requestIdSchema = z.object({
  clientRequestId: z.string({ error: "Bitte gib eine gültige Anfragekennung an." })
    .uuid("Die Anfragekennung muss eine gültige UUID sein.").optional(),
});

const importSchema = z.object({
  importId: z.string({ error: "Bitte gib eine gültige Importkennung an." })
    .uuid("Die Importkennung muss eine gültige UUID sein."),
  transactions: z.array(z.unknown(), { error: "Bitte gib eine Liste von Transaktionen an." })
    .min(1, "Der Import muss mindestens eine Transaktion enthalten.")
    .max(MAX_IMPORT_TRANSACTIONS, `Der Import darf höchstens ${MAX_IMPORT_TRANSACTIONS} Transaktionen enthalten.`),
});

/**
 * „Heute“ aus Sicht der östlichsten Zeitzone (UTC+14): Der Server kennt die Zeitzone des Nutzers nicht,
 * daher darf eine Buchung mit dem lokalen Tagesdatum nie fälschlich als „in der Zukunft“ gelten
 * (z. B. kurz nach Mitternacht in Deutschland, wenn in UTC noch der Vortag ist).
 */
function latestLocalDate(now: Date): string {
  return new Date(now.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validatedInput(body: unknown, now: Date): TransactionInput {
  const result = validateTransactionInput(body, latestLocalDate(now));
  if (!result.ok) {
    throw new ApiError(400, "VALIDATION_ERROR", "Bitte prüfe deine Transaktion.", result.fields);
  }
  return result.value;
}

async function assertSequence(repos: Repositories, userId: string, instrumentId: string): Promise<void> {
  const result = validateTransactionSequence(await repos.transactions.list(userId, instrumentId));
  if (!result.ok) {
    throw new ApiError(409, "CONFLICT", result.message, { quantity: result.message });
  }
}

function missingTransaction(): never {
  throw new ApiError(404, "NOT_FOUND", "Die Transaktion wurde nicht gefunden.");
}

export function createTransactionsRouter({ repos, now }: TransactionsDependencies): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const instrumentId = req.query.instrumentId === undefined ? undefined : parse(instrumentIdSchema, req.query.instrumentId);
    res.json({ transactions: await repos.transactions.list(res.locals.userId as string, instrumentId) });
  });

  router.post("/", async (req, res) => {
    const userId = res.locals.userId as string;
    const { clientRequestId } = parse(requestIdSchema, req.body);
    let result: { status: number; transaction: Transaction };
    try {
      result = await repos.atomic(async (tx) => {
        if (clientRequestId) {
          const existing = await tx.transactions.findByClientRequestId(userId, clientRequestId);
          if (existing) return { status: 200, transaction: existing };
        }
        const currentTime = now();
        const input = validatedInput(req.body, currentTime);
        const transaction = await tx.transactions.create(userId, { ...input, clientRequestId }, currentTime.toISOString());
        await assertSequence(tx, userId, transaction.instrumentId);
        return { status: 201, transaction };
      }, { lockKey: userId });
    } catch (error) {
      if (!clientRequestId || !isUniqueViolation(error)) throw error;
      // Nach dem Rollback kann die konkurrierende Anfrage erneut gelesen werden.
      const existing = await repos.transactions.findByClientRequestId(userId, clientRequestId);
      if (!existing) throw error;
      result = { status: 200, transaction: existing };
    }
    res.status(result.status).json(result.transaction);
  });

  router.post("/import", async (req, res) => {
    const userId = res.locals.userId as string;
    const { importId, transactions: rows } = parse(importSchema, req.body);
    const prefix = `${importId}:`;
    let result: { status: number; transactions: Transaction[] };
    try {
      result = await repos.atomic(async (tx) => {
        const existing = await tx.transactions.listByClientRequestIdPrefix(userId, prefix);
        if (existing.length > 0) return { status: 200, transactions: existing };

        const currentTime = now();
        const date = latestLocalDate(currentTime);
        const inputs: TransactionInput[] = [];
        const fields: Record<string, string> = {};
        rows.forEach((row, index) => {
          // Importzeilen erhalten ausschließlich die vom Server erzeugte Anfragekennung.
          const body = typeof row === "object" && row !== null && !Array.isArray(row)
            ? { ...row, clientRequestId: undefined }
            : row;
          const validation = validateTransactionInput(body, date);
          if (validation.ok) {
            inputs.push({ ...validation.value, clientRequestId: `${prefix}${index}` });
          } else {
            for (const [field, message] of Object.entries(validation.fields)) fields[`rows.${index}.${field}`] = message;
          }
        });
        if (Object.keys(fields).length > 0) {
          throw new ApiError(400, "VALIDATION_ERROR", "Bitte prüfe die Transaktionen deines Imports.", fields);
        }

        const transactions: Transaction[] = [];
        for (const input of inputs) {
          transactions.push(await tx.transactions.create(userId, input, currentTime.toISOString()));
        }
        const instruments = new Map(inputs.map((input) => [input.instrument.id, input.instrument]));
        for (const [instrumentId, instrument] of instruments) {
          const sequence = validateTransactionSequence(await tx.transactions.list(userId, instrumentId));
          if (!sequence.ok) throw new ApiError(409, "CONFLICT", `${instrument.symbol}: ${sequence.message}`);
        }
        return { status: 201, transactions };
      }, { lockKey: userId });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await repos.transactions.listByClientRequestIdPrefix(userId, prefix);
      if (existing.length === 0) throw error;
      result = { status: 200, transactions: existing };
    }
    const body: ImportTransactionsResponse = { created: result.transactions.length, transactions: result.transactions };
    res.status(result.status).json(body);
  });

  router.put("/:id", async (req, res) => {
    const userId = res.locals.userId as string;
    const id = req.params.id as string;
    const transaction = await repos.atomic(async (tx) => {
      const existing = await tx.transactions.get(userId, id) ?? missingTransaction();
      const currentTime = now();
      const input = validatedInput(req.body, currentTime);
      const updated = await tx.transactions.update(userId, id, input, currentTime.toISOString()) ?? missingTransaction();
      await assertSequence(tx, userId, existing.instrumentId);
      if (updated.instrumentId !== existing.instrumentId) await assertSequence(tx, userId, updated.instrumentId);
      return updated;
    }, { lockKey: userId });
    res.json(transaction);
  });

  router.delete("/:id", async (req, res) => {
    const userId = res.locals.userId as string;
    const id = req.params.id as string;
    await repos.atomic(async (tx) => {
      const existing = await tx.transactions.get(userId, id) ?? missingTransaction();
      await tx.transactions.delete(userId, id);
      await assertSequence(tx, userId, existing.instrumentId);
    }, { lockKey: userId });
    res.sendStatus(204);
  });

  return router;
}
