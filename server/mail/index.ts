import nodemailer from "nodemailer";

export interface Mailer {
  readonly mode: "smtp" | "console";
  sendPasswordReset(email: string, resetUrl: string): Promise<void>;
}

export function createMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const host = env.SMTP_HOST?.trim();
  if (!host) {
    return {
      mode: "console",
      async sendPasswordReset(email, resetUrl) {
        console.info(`[LOKALER MODUS – KEIN E-MAIL-VERSAND] Passwort zurücksetzen für ${email}: ${resetUrl}`);
      },
    };
  }
  const configuredPort = Number(env.SMTP_PORT ?? "587");
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 587;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } } : {}),
  });
  return {
    mode: "smtp",
    async sendPasswordReset(email, resetUrl) {
      await transport.sendMail({
        from: env.SMTP_FROM ?? "Aktien-Tracker <noreply@localhost>",
        to: email,
        subject: "Passwort für den Aktien-Tracker zurücksetzen",
        text: `Sie haben ein neues Passwort für den Aktien-Tracker angefordert.\n\nÖffnen Sie diesen Link: ${resetUrl}\n\nDer Link ist 60 Minuten lang gültig und kann nur einmal verwendet werden.\nFalls Sie die Anfrage nicht gestellt haben, können Sie diese Nachricht ignorieren.`,
      });
    },
  };
}
