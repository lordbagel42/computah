import { createDashboardServer, readDashboardConfig } from "./server.mjs";

const config = readDashboardConfig(process.env);
const server = createDashboardServer(config);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, "0.0.0.0", () => {
  console.info("Computah dashboard listening; operator login required");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
