import { describe, expect, it } from "vitest";
import { createSmtpSender } from "./email.js";
import { parseOwnerEmails } from "../runtime/config.js";

// Sends ONE real email to the first address in CORBITS_OWNER_EMAILS using your SMTP settings.
// Run with `pnpm test:live`. Skipped unless SMTP user, password and owner emails are set.
try {
  process.loadEnvFile(".env");
} catch {
  /* rely on process env */
}
const { CORBITS_SMTP_USER: user, CORBITS_SMTP_PASS: pass, CORBITS_OWNER_EMAILS: owners } = process.env;

describe.skipIf(!user || !pass || !owners)("SMTP delivery (live)", () => {
  it("delivers a test message to the first owner address", async () => {
    const to = [...parseOwnerEmails(owners!).values()][0]!;
    const sender = createSmtpSender({
      host: process.env.CORBITS_SMTP_HOST ?? "smtp.gmail.com",
      port: Number(process.env.CORBITS_SMTP_PORT ?? 465),
      user: user!,
      pass: pass!,
      from: process.env.CORBITS_SMTP_FROM ?? user!,
    });
    await expect(
      sender.send({
        to,
        subject: "[Corbits] Test notification",
        text: "If you can read this, Corbits can send you email. No action needed.",
        messageId: `<live-test.${Date.now()}@corbits.local>`,
      }),
    ).resolves.toBeUndefined();
  });
});
