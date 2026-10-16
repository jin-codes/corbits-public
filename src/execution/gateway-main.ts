// Entry point of the "gateway" container. It does two things for the sandboxed browser:
//   1. runs the egress proxy, the browser's only way out (private networks are refused);
//   2. relays one published port to the browser's control socket, because the browser container
//      sits on an internal network that Docker cannot publish ports from.
// It holds no secrets and touches no files.
import net from "node:net";
import { EgressProxy } from "./egress-proxy.js";

const proxyPort = Number(process.env.EGRESS_PORT ?? 3128);
const relayPort = Number(process.env.RELAY_PORT ?? 9222);
const [targetHost, targetPortStr] = (process.env.RELAY_TARGET ?? "browser:3000").split(":");
const targetPort = Number(targetPortStr);
const allowPrivate = process.env.EGRESS_ALLOW_PRIVATE_NETWORK === "true";

const proxy = await EgressProxy.start({ allowPrivateNetwork: allowPrivate }, { host: "0.0.0.0", port: proxyPort });
proxy.onBlock = (entry) => console.log(`[egress] refused ${entry}`);

const relay = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  const close = () => (client.destroy(), upstream.destroy());
  client.on("error", close);
  upstream.on("error", close);
  client.pipe(upstream);
  upstream.pipe(client);
});
await new Promise<void>((resolve) => relay.listen(relayPort, "0.0.0.0", resolve));

console.log(`[gateway] egress proxy :${proxyPort} (private network ${allowPrivate ? "ALLOWED" : "blocked"}), relay :${relayPort} -> ${targetHost}:${targetPort}`);

const stop = async () => {
  relay.close();
  await proxy.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
