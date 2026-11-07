/** npx tsx eval/check-split.ts scenario.json split.json | scenario.json --sheet | scenario.json --template */
import fs from "node:fs";
import { parseSnapshot } from "@/lib/planner/snapshot";
import { assessManual, compareHaatInputs, scenarioSheet } from "./manual";

try {
  const [scenarioPath, answerPath, compareFlag, comparePath] = process.argv.slice(2);
  if (!scenarioPath || !answerPath) throw new Error("Usage: check-split.ts scenario.json split.json | scenario.json --sheet | scenario.json --template. Export the scenario from the coordinator page first.");
  const snapshot = parseSnapshot(JSON.parse(fs.readFileSync(scenarioPath, "utf8")));
  if (answerPath === "--sheet") console.log(scenarioSheet(snapshot));
  else if (answerPath === "--template") console.log(JSON.stringify({ scenarioFingerprint: snapshot.fingerprint, decision: "yes", priceUsdCents: null, production: [], finishing: [] }, null, 2));
  else {
    const result = assessManual(snapshot, JSON.parse(fs.readFileSync(answerPath, "utf8")));
    if (compareFlag && (compareFlag !== "--compare" || !comparePath)) throw new Error("Use --compare after-haat.json to verify live-round inputs.");
    const sameHaatInputs = comparePath ? compareHaatInputs(snapshot, parseSnapshot(JSON.parse(fs.readFileSync(comparePath, "utf8")))) : null;
    if (sameHaatInputs === false) throw new Error("The live Haat answer was not evaluated on the same inputs. Refresh/export Haat's result, or rerun both rounds on a new scenario.");
    console.log(JSON.stringify({ ...result, sameHaatInputs }, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 2;
}
