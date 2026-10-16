// Runs inside the sandboxed browser container. Chromium is started by the operator (this file),
// with the proxy flags baked in, so a client that connects cannot loosen them.
import { chromium } from "playwright";

const wsPath = process.env.BROWSER_WS_PATH;
const proxy = process.env.EGRESS_PROXY;
if (!wsPath || wsPath.length < 24) throw new Error("BROWSER_WS_PATH must be a secret of at least 24 characters");
if (!proxy) throw new Error("EGRESS_PROXY is required: the browser has no other way to reach the network");

const server = await chromium.launchServer({
  host: "0.0.0.0",
  port: 3000,
  wsPath,
  headless: true,
  // Keep Chromium's own sandbox on; the container's seccomp profile allows the user namespaces it needs.
  chromiumSandbox: true,
  args: [`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>", "--disable-dev-shm-usage"],
});
console.log("[browser] ready (endpoint path not logged)");

const stop = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
