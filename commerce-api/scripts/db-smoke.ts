import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
try {
  const result = await db.$queryRaw<
    Array<{ dbName: string; dbUser: string }>
  >`SELECT DATABASE() AS dbName, CURRENT_USER() AS dbUser`;
  console.log(
    JSON.stringify({
      connected: true,
      database: result[0]?.dbName,
      user: result[0]?.dbUser,
    }),
  );
} finally {
  await db.$disconnect();
}
