import "../worker/env";
import { ANCHOR_PROMPT, generateAnchor } from "@/lib/anchor";
import { enabled } from "@/lib/config";

/** Casts (or recasts) the anchor: pnpm anchor. Delete data/anchor/studio.jpg first to replace it. */
if (!enabled.bfl()) {
  console.error("BFL_API_KEY is not set in .env.local");
  process.exit(1);
}
console.log(`Generating the studio still with FLUX.2 [pro]...\n${ANCHOR_PROMPT}\n`);
const file = await generateAnchor((status) => console.log(`  ${status}`));
console.log(`Saved ${file}`);
