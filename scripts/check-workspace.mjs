import fs from "fs";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.ts";

const envContent = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx !== -1) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  console.log("Found workspaces count:", workspaces.length);
  for (const ws of workspaces) {
    console.log(`\nWorkspace ID: ${ws.id}, Title: ${ws.title}`);
    console.log("FileData keys:", ws.fileData ? Object.keys(ws.fileData.files || {}) : "NULL");
    if (ws.fileData?.files) {
      for (const [filepath, fileobj] of Object.entries(ws.fileData.files)) {
        console.log(`  File: "${filepath}" (length: ${fileobj.code?.length})`);
        console.log(`  Sample code:`, fileobj.code?.slice(0, 150));
      }
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
