import { ConfigStore } from "../core/store.js";
import { startDaemon } from "./server.js";

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg
  ? parseInt(portArg.split("=")[1], 10)
  : ConfigStore.load().settings.daemonPort;

startDaemon(port).catch((err) => {
  console.error("Failed to start Harbor daemon:", err);
  process.exit(1);
});
