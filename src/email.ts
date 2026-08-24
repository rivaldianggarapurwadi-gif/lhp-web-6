import { Resend } from "resend";
import type { Pool } from "pg";
import { config } from "./config.js";

/**
 * Additive, not load-bearing -- same pattern as push.ts. Unset
 * RESEND_API_KEY and this is a silent no-op everywhere, so local dev and
 * any deploy that hasn't configured it yet just run without the email
 * channel rather than crashing.
 */
const client = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export interface EmailPayload {
  subject: string;
  text: string;
}

/**
 * One email per notification-worthy event, same immediacy as push -- no
 * batching or debouncing. Fine at this scale; worth revisiting (a short
 * per-recipient cooldown, or batching into a digest) if a recipient being
 * offline for a while starts meaning a burst of individual emails.
 */
export async function sendEmailToUser(pool: Pool, userId: string, payload: EmailPayload): Promise<void> {
  if (!client) {
    console.log(`[email] skipped for ${userId}: RESEND_API_KEY not configured`);
    return;
  }

  const { rows } = await pool.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [
    userId,
  ]);
  const email = rows[0]?.email;
  if (!email) {
    console.log(`[email] skipped for ${userId}: no email address on file`);
    return;
  }

  try {
    const { error } = await client.emails.send({
      from: config.emailFrom,
      to: email,
      subject: payload.subject,
      text: payload.text,
    });
    if (error) console.error("[email] send failed", error.name, error.message);
    else console.log(`[email] sent to ${userId}`);
  } catch (err: any) {
    console.error("[email] send failed", err?.message);
  }
}
