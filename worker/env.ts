import fs from "node:fs";

// Next.js loads .env.local for the web app; the worker loads it here, before any config is read.
for (const file of [".env.local", ".env"]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
