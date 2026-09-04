#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase } from "@zhujun/agentloop";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const databasePath = resolve(appRoot, process.env.DATABASE_PATH ?? "./data/agentloop.db");

if (databasePath === ":memory:") {
  throw new Error("DATABASE_PATH cannot be :memory: for init-db");
}

mkdirSync(dirname(databasePath), { recursive: true });

const database = new AppDatabase(databasePath);
await database.ready();
await database.close();

console.log(`Initialized SQLite database at ${databasePath}`);
