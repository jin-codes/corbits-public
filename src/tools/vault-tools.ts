import { z } from "zod";
import type { BrowserAdapter } from "../execution/browser-adapter.js";
import type { Redactor } from "../security/redact.js";
import type { OneTimeTaker } from "../vault/one-time.js";
import { normalizeOrigin, type VaultReader } from "../vault/secret-store.js";
import { PageResult, Ref, pageAfter } from "./browser-tools.js";
import { defineTool, type AnyTool } from "./types.js";

const SecretName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/**
 * The one tool that can put a saved credential into a page. The model supplies a field and a
 * credential's NAME; the value is looked up and typed here, in code, and goes nowhere else:
 *  - only into a password field, and only on the exact site the credential was saved for;
 *  - always behind a human approval, bound to the field, the page and the credential name;
 *  - the value is never returned, logged, stored in history, or shown to the model.
 * Usernames and emails are not secrets: the agent types those with browser.type.
 */
export function createVaultTools(d: { browser: BrowserAdapter; vault: VaultReader; owner: string; redactor: Redactor; oneTime?: OneTimeTaker }): AnyTool[] {
  const { browser, vault, owner, redactor, oneTime } = d;
  const tools: AnyTool[] = [
    defineTool({
      name: "browser.type_secret",
      description:
        "Type a saved credential into the password field with the given ref from the latest snapshot, then return the resulting page. You only know the credential's name (see the saved credentials list); its value is never shown to you. It works only in password fields on the site the credential was saved for, and always requires human approval. Type usernames and emails with browser.type instead.",
      inputSchema: z.object({ ref: Ref, secretName: SecretName }).strict(), // an extra field such as a "value" is refused, not ignored
      outputSchema: PageResult,
      permissions: ["browser.type_secret"],
      risk: "consequential",
      consequentialKind: "use_credentials",
      effect: ({ secretName }) => `credential:${secretName}`,
      timeoutMs: 30_000,
      retry: { maxAttempts: 1, backoffMs: 0 },

      inspect: async ({ ref, secretName }) => {
        const [element, meta] = await Promise.all([browser.inspect(ref), vault.meta(owner, secretName)]);
        return { ...element, pageOrigin: originOf(browser.currentUrl()), secretName, secretExists: meta !== null, secretOrigin: meta?.origin ?? null };
      },

      precheck: ({ secretName }, inspection) => {
        if (!inspection || inspection.inspectionFailed) return "The target field could not be inspected, so no credential was typed.";
        if (inspection.secretExists !== true) return `There is no saved credential named "${secretName}".`;
        if (inspection.inputType !== "password") return "Saved credentials can only be typed into password fields.";
        if (!inspection.secretOrigin || inspection.pageOrigin !== inspection.secretOrigin) {
          return `The credential "${secretName}" is only allowed on ${String(inspection.secretOrigin)}, but this page is ${String(inspection.pageOrigin)}.`;
        }
        return null;
      },

      handler: async ({ ref, secretName }) => {
        try {
          const found = await vault.reveal(owner, secretName);
          if (!found) throw new Error(`no saved credential named "${secretName}"`);
          // Checked again at the moment of use: the page may have changed since the approval.
          if (originOf(browser.currentUrl()) !== found.origin) throw new Error("the page is no longer on the site this credential is allowed for");
          const el = await browser.inspect(ref);
          if (el.inputType !== "password") throw new Error("the target is not a password field");
          // From here the value exists only in memory, and any copy that leaks into output is scrubbed.
          redactor.addSecret(found.value);
          await browser.type(ref, found.value);
          return redactor.redact(await pageAfter(browser));
        } catch (err) {
          throw new Error(redactor.redactString(err instanceof Error ? err.message : String(err)));
        }
      },
    }),
  ];

  if (oneTime) {
    tools.push(
      defineTool({
        name: "browser.ask_password",
        description:
          "Ask the user for a password and type it into the password field with the given ref from the latest snapshot. Use this when no saved credential fits. The user types the password into the approval card; you never see it. It works only in password fields on https pages and always requires the user's approval. Type usernames and emails with browser.type instead.",
        inputSchema: z.object({ ref: Ref }).strict(),
        outputSchema: PageResult,
        permissions: ["browser.type_secret"],
        risk: "consequential",
        consequentialKind: "use_credentials",
        timeoutMs: 30_000,
        retry: { maxAttempts: 1, backoffMs: 0 },

        inspect: async ({ ref }) => ({ ...(await browser.inspect(ref)), pageOrigin: originOf(browser.currentUrl()) }),

        precheck: (_input, inspection) => {
          if (!inspection || inspection.inspectionFailed) return "The target field could not be inspected, so no password was requested.";
          if (inspection.inputType !== "password") return "A password can only be entered into a password field.";
          try {
            normalizeOrigin(String(inspection.pageOrigin)); // https only (plain http just for localhost)
          } catch {
            return "A password can only be entered on an https page.";
          }
          return null;
        },

        handler: async ({ ref }, ctx) => {
          try {
            if (!ctx.approvalId) throw new Error("no approval to use");
            // Taken (and deleted) only now, at the moment of use.
            const entered = await oneTime.take(ctx.approvalId);
            if (!entered) throw new Error("no password was entered with the approval");
            if (originOf(browser.currentUrl()) !== entered.origin) throw new Error("the page is no longer the one the password was entered for");
            const el = await browser.inspect(ref);
            if (el.inputType !== "password") throw new Error("the target is not a password field");
            redactor.addSecret(entered.value);
            await browser.type(ref, entered.value);
            return redactor.redact(await pageAfter(browser));
          } catch (err) {
            throw new Error(redactor.redactString(err instanceof Error ? err.message : String(err)));
          }
        },
      }),
    );
  }
  return tools;
}
