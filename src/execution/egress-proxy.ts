import { lookup } from "node:dns/promises";
import http from "node:http";
import net, { isIP, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { isPrivateAddress, isPrivateHostname } from "./network.js";

export interface EgressPolicy {
  /** Allow loopback / private / link-local targets. Off by default. */
  allowPrivateNetwork: boolean;
  /** Extra explicit "host:port" denials (also useful in tests). */
  blockHostPorts?: readonly string[];
}

class Blocked extends Error {}

const HOP_BY_HOP = ["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/**
 * Local forward proxy the browser is forced through. Every request and every redirect hop
 * passes through here, which a request-interception hook cannot guarantee (redirect targets
 * are followed inside the network stack). It resolves DNS itself, rejects private targets, and
 * connects to the address it vetted, so a hostname cannot resolve differently at connect time.
 */
export class EgressProxy {
  readonly blocked: string[] = [];
  /** Optional sink for refusals (the gateway container logs them). */
  onBlock?: (entry: string) => void;
  private constructor(
    private readonly server: http.Server,
    private readonly policy: EgressPolicy,
  ) {}

  /** Listens on loopback with a random port by default; the gateway container binds a fixed port on all interfaces. */
  static async start(policy: EgressPolicy, listen: { host?: string; port?: number } = {}): Promise<EgressProxy> {
    const server = http.createServer();
    const proxy = new EgressProxy(server, policy);
    server.on("request", (req, res) => void proxy.forward(req, res));
    server.on("connect", (req, socket, head) => void proxy.tunnel(req, socket, head));
    await new Promise<void>((resolve) => server.listen(listen.port ?? 0, listen.host ?? "127.0.0.1", resolve));
    return proxy;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Returns the vetted IP to connect to, or throws Blocked. */
  private async vet(host: string, port: number): Promise<string> {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (this.policy.blockHostPorts?.includes(`${h}:${port}`)) throw new Blocked("explicitly blocked");
    if (!this.policy.allowPrivateNetwork && isPrivateHostname(h)) throw new Blocked("private hostname");
    const addrs = isIP(h) ? [h] : (await lookup(h, { all: true })).map((a) => a.address);
    if (addrs.length === 0) throw new Blocked("unresolvable");
    if (!this.policy.allowPrivateNetwork && addrs.some(isPrivateAddress)) throw new Blocked("private address");
    return addrs[0]!;
  }

  /** Records a refusal. Only host and port are kept: paths and query strings can carry secrets. */
  private note(reason: string, target: string) {
    let where = target;
    try {
      const u = new URL(target.includes("://") ? target : `tcp://${target}`);
      where = u.host;
    } catch {
      /* keep the raw host:port form */
    }
    const entry = `${reason}: ${where}`;
    this.blocked.push(entry);
    this.onBlock?.(entry);
  }

  private async tunnel(req: http.IncomingMessage, client: Duplex, head: Buffer) {
    const [host, portStr] = splitHostPort(req.url ?? "", 443);
    try {
      const ip = await this.vet(host, portStr);
      const upstream = net.connect(portStr, ip, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const close = () => (upstream.destroy(), client.destroy());
      upstream.on("error", close);
      client.on("error", close);
    } catch (err) {
      if (err instanceof Blocked) this.note(err.message, req.url ?? "");
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse) {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    try {
      const port = Number(target.port || 80);
      const ip = await this.vet(target.hostname, port);
      const headers = { ...req.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      const upstream = http.request({ host: ip, port, method: req.method, path: target.pathname + target.search, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => res.headersSent || res.writeHead(502).end());
      req.pipe(upstream);
    } catch (err) {
      if (err instanceof Blocked) this.note(err.message, req.url ?? "");
      res.writeHead(403, { "content-type": "text/plain" }).end("blocked by egress policy");
    }
  }
}

function splitHostPort(hostport: string, defaultPort: number): [string, number] {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostport);
  return m ? [m[1]!, m[2] ? Number(m[2]) : defaultPort] : [hostport, defaultPort];
}
