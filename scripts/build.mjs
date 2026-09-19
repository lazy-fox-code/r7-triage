// Упаковка XPI. Никакой транспиляции: Thunderbird 115 понимает
// современный JS, а сборщик только усложнил бы отладку.
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

mkdirSync("dist", { recursive: true });
execFileSync("zip", ["-r", "-FS", "dist/r7-triage.xpi",
  "manifest.json", "src", "_locales", "-x", "*.DS_Store"],
  { stdio: "inherit" });
console.log("dist/r7-triage.xpi");
