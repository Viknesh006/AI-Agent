import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local" });

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
console.log("Connected to database!");

await client.query(`
  CREATE TABLE IF NOT EXISTS "User" (
    "id"        TEXT         NOT NULL,
    "clerkId"   TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "email"     TEXT         NOT NULL,
    "imageUrl"  TEXT         NOT NULL DEFAULT '',
    "credits"   INTEGER      NOT NULL DEFAULT 10,
    "plan"      TEXT         NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
  );
`);
await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "User_clerkId_key" ON "User"("clerkId");`);
await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key"   ON "User"("email");`);

await client.query(`
  CREATE TABLE IF NOT EXISTS "Workspace" (
    "id"        TEXT         NOT NULL,
    "title"     TEXT,
    "userId"    TEXT         NOT NULL,
    "messages"  JSONB        NOT NULL DEFAULT '[]',
    "fileData"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Workspace_pkey"     PRIMARY KEY ("id"),
    CONSTRAINT "Workspace_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
  );
`);
await client.query(`CREATE INDEX IF NOT EXISTS "Workspace_userId_idx" ON "Workspace"("userId");`);

console.log("✅ Tables created successfully!");
await client.end();
