// Упаковка XPI. Никакой транспиляции: Thunderbird 115 понимает современный
// JS, а сборщик только усложнил бы отладку.
//
//   node scripts/build.mjs             отладочная сборка
//   node scripts/build.mjs --release   сборка с обфускацией
//
// Про обфускацию — честно, до того как на неё понадеются.
//
// 1. Расширение целиком исполняется на машине пользователя. XPI — это zip,
//    он распаковывается и читается. Обфускация поднимает стоимость разбора
//    кода, но ничего не делает невозможным. Проверку срока из src/trial.js
//    она защищает ровно настолько же: от любопытства, не от снятия.
//
// 2. Для подписи на addons.thunderbird.net обфускация недопустима: правила
//    Mozilla требуют читаемого исходника, минификация разрешена, обфускация
//    нет. Решение принято: распространение через корпоративные политики,
//    на ATN расширение не публикуется.
//
// 3. Тяжёлые режимы обфускатора (controlFlowFlattening, deadCodeInjection,
//    selfDefending) замедляют код в разы. Здесь проход по ящику на десятки
//    тысяч писем — они выключены намеренно, не включать не подумав.
//
// 4. Обфусцированная сборка прогоняется тестами перед упаковкой. Обфускатор
//    умеет ломать приватные поля классов и порядок вычислений; сломанный
//    релиз, уехавший по политике на рабочие места, дороже любой защиты кода.

import { cpSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname, resolve } from "node:path";

const release = process.argv.includes("--release");
const STAGE = "dist/stage";
const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
const xpi = `dist/r7-triage-${version}${release ? "" : "-dev"}.xpi`;

rmSync("dist", { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const item of ["manifest.json", "src", "_locales"]) {
  cpSync(item, join(STAGE, item), { recursive: true });
}

// Дата сборки для отсчёта демоверсии. В релизе впекается и якорит 90 дней —
// переустановка профиля срок не сбрасывает (см. src/trial.js). В отладке 0:
// срок считается от установки, как и раньше. Дату задаёт CI через
// R7_BUILD_DATE=ГГГГ-ММ-ДД (тот же день, что и пароль архива в релизе);
// без переменной берётся текущий день сборки.
const buildDateMs = release ? resolveBuildDate() : 0;
writeFileSync(
  join(STAGE, "src", "build-info.js"),
  "// Сгенерировано scripts/build.mjs при упаковке. Вручную не править.\n" +
  `export const BUILD_DATE_MS = ${buildDateMs};\n`);
if (release) {
  console.log(`дата сборки: ${new Date(buildDateMs).toISOString().slice(0, 10)}`);
}

if (release) {
  obfuscate(join(STAGE, "src"));
  verify(join(STAGE, "src"));
}

rmSync(xpi, { force: true });
execFileSync("zip", ["-r", "-FS", "-q", `../../${xpi}`,
  "manifest.json", "src", "_locales", "-x", "*.DS_Store"],
  { cwd: STAGE, stdio: "inherit" });

rmSync(STAGE, { recursive: true, force: true });
console.log(`${xpi}${release ? " (обфусцирован)" : ""}`);

// -------------------------------------------------------------------------

// Дата релиза в миллисекундах (полночь UTC). Берётся из R7_BUILD_DATE
// (ГГГГ-ММ-ДД), заданной сборкой CI; локально — текущий день.
function resolveBuildDate() {
  const iso = process.env.R7_BUILD_DATE;
  const ms = iso ? Date.parse(`${iso}T00:00:00Z`) : Date.now();
  if (Number.isNaN(ms)) {
    console.error(`Неверный R7_BUILD_DATE: ${iso} (нужно ГГГГ-ММ-ДД).`);
    process.exit(1);
  }
  return ms;
}

function obfuscate(dir) {
  const bin = ["node_modules/.bin/javascript-obfuscator"]
    .find((p) => existsSync(p));
  if (!bin) {
    console.error(
      "Для сборки релиза нужен javascript-obfuscator:\n" +
      "  npm i -D javascript-obfuscator\n" +
      "Без него собирайте отладочную версию: npm run build");
    process.exit(1);
  }

  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (extname(p) === ".js") files.push(p);
    }
  })(dir);

  for (const file of files) {
    execFileSync(bin, [
      file, "--output", file,
      "--target", "browser",
      "--compact", "true",
      "--identifier-names-generator", "mangled",
      "--string-array", "true",
      "--string-array-encoding", "base64",
      "--string-array-threshold", "0.75",
      // Осознанно выключено: стоимость исполнения выше пользы.
      "--control-flow-flattening", "false",
      "--dead-code-injection", "false",
      "--self-defending", "false",
      "--debug-protection", "false",
    ], { stdio: "inherit" });
  }
  console.log(`обфусцировано файлов: ${files.length}`);
}

/** Те же тесты, но поверх обфусцированного кода. */
function verify(dir) {
  console.log("проверка обфусцированной сборки…");
  try {
    execFileSync(process.execPath, ["test/run.mjs"], {
      stdio: "inherit",
      env: { ...process.env, R7_SRC: resolve(dir) },
    });
  } catch {
    console.error(
      "\nОбфусцированная сборка не прошла тесты. XPI не собран.\n" +
      "Смотрите, какой режим обфускатора это сломал, в scripts/build.mjs.");
    process.exit(1);
  }
}
