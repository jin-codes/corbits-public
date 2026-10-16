// Serves the evaluation site on a fixed port so you can point a dashboard task at it:
//   pnpm tsx src/eval/serve.ts [port]      (default 8799; the site is at http://127.0.0.1:PORT/)
import { startSite } from "./site.js";

const port = Number(process.argv[2] ?? 8799);
const site = await startSite(port);
console.log(`Evaluation site: ${site.origin}/`);
process.on("SIGTERM", () => void site.stop().then(() => process.exit(0)));
