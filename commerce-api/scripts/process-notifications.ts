import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../src/config.js";
import { processNotificationBatch } from "../src/notification-worker.js";
const config = loadConfig();
const db = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
try { console.log(JSON.stringify(await processNotificationBatch({ db, config }))); }
finally { await db.$disconnect(); }
