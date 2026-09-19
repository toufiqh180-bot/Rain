import { env, emailConfigured } from "./env.js";

/**
 * Sends transactional mail when Resend is configured.
 * Without credentials the token is only logged — never returned to the client.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  log: { info: (obj: object, msg?: string) => void };
  event: string;
  accountId: string;
}): Promise<void> {
  if (!emailConfigured) {
    input.log.info({ event: input.event, accountId: input.accountId }, "email delivery not configured");
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    input.log.info(
      { event: `${input.event}_failed`, accountId: input.accountId, status: response.status, detail },
      "email send failed",
    );
  }
}
