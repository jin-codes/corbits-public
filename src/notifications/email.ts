import nodemailer, { type Transporter } from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable per notification, so a re-send after a crash carries the same Message-ID. */
  messageId: string;
}

/** Throws if the message was not accepted for delivery. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class SmtpSender implements EmailSender {
  constructor(
    private readonly transport: Pick<Transporter, "sendMail">,
    private readonly from: string,
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      messageId: m.messageId,
    });
    // Real SMTP transports report accepted/rejected recipients; treat any rejection (or an
    // explicitly empty accepted list) as a failed delivery. Test transports omit both fields.
    if (info.rejected?.length) throw new Error("recipient rejected by SMTP server");
    if (info.accepted && info.accepted.length === 0) throw new Error("SMTP server accepted no recipients");
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function createSmtpSender(cfg: SmtpConfig): SmtpSender {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // implicit TLS on 465; other ports upgrade via STARTTLS
    requireTLS: cfg.port !== 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return new SmtpSender(transport, cfg.from);
}
