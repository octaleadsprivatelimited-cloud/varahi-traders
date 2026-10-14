import { createApp } from "./app.js";
import { startNotificationWorker } from "./notification-worker.js";

const { app, config, persistence } = await createApp();
const stopNotifications = persistence && config.NODE_ENV === "production"
  ? startNotificationWorker({ db: persistence.db, config }) : async () => {};
const server = app.listen(config.PORT, () =>
  console.log(`Commerce API listening on http://localhost:${config.PORT}`),
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await stopNotifications();
    await persistence?.disconnect();
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
