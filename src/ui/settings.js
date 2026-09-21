// Настройки. Ни адреса модели, ни порогов разбора в коде нет — всё отсюда.

import * as settings from "../settings.js";

const $ = (id) => document.getElementById(id);

const LLM_NUM = ["concurrency", "bodyLimit", "timeoutMs"];
const SCAN_NUM = ["recentDays", "idleSeconds", "archiveRecheckDays",
  "targetPerWindow", "initialWindowDays", "minWindowDays",
  "maxWindowDays", "overlapDays", "floorYear", "throttleMs"];
const SCAN_BOOL = ["archiveOnIdle", "autoResume"];
const MB = 1048576;

const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

async function fill() {
  const cfg = await settings.load();
  $("endpoint").value = cfg.llm.endpoint;
  $("model").value = cfg.llm.model;
  for (const k of LLM_NUM) $(k).value = cfg.llm[k];
  for (const k of SCAN_NUM) $(k).value = cfg.scan[k];
  $("excludeFolderTypes").value = cfg.scan.excludeFolderTypes.join(", ");
  for (const k of SCAN_BOOL) $(k).checked = cfg.scan[k];

  $("enrichEnabled").checked = cfg.enrich.enabled;
  $("enrichFreshDelay").value = cfg.enrich.freshDelayMinutes;
  $("enrichMaxSizeMb").value = Math.round(cfg.enrich.maxSizeBytes / MB);
  $("enrichThrottleMs").value = cfg.enrich.throttleMs;
  $("massCcRecipients").value = cfg.gate.massCcRecipients;
  $("aliases").value = cfg.me.aliases.join(", ");
  $("tcHosts").value = cfg.trueconf.hosts.join(", ");
}

/**
 * Разрешение на сеть запрашивается под конкретный адрес и только по нажатию
 * пользователя. Сетевых адресатов два — эндпоинт модели и сервер TrueConf;
 * зашивать их в манифест нельзя, а просить `<all_urls>` — тем более.
 *
 * Вызывать синхронно из обработчика нажатия, до любого await: Firefox
 * принимает permissions.request только внутри пользовательского действия.
 * Уже выданное разрешение запрос подтверждает без диалога.
 */
function grantEndpoint(endpoint) {
  if (!endpoint) return Promise.resolve(true);
  const url = new URL(endpoint);
  return browser.permissions.request({ origins: [`${url.protocol}//${url.host}/*`] });
}

$("save").addEventListener("click", async () => {
  $("error").textContent = "";
  $("saved").hidden = true;

  const endpoint = $("endpoint").value.trim().replace(/\/+$/, "");
  let granted;
  try {
    granted = grantEndpoint(endpoint);   // до любого await — см. выше
  } catch {
    $("error").textContent = "Адрес эндпоинта разобрать не получилось.";
    return;
  }

  if (!(await granted.catch(() => false))) {
    $("error").textContent =
      "Без разрешения на этот адрес расширение не сможет обратиться к модели. " +
      "Остальные настройки сохранены.";
  }

  const llm = { endpoint, model: $("model").value.trim() };
  for (const k of LLM_NUM) llm[k] = Number($(k).value);

  const scan = { excludeFolderTypes: list($("excludeFolderTypes").value) };
  for (const k of SCAN_NUM) scan[k] = Number($(k).value);
  for (const k of SCAN_BOOL) scan[k] = $(k).checked;

  await settings.save("llm", llm);
  await settings.save("scan", scan);
  await settings.save("enrich", {
    enabled: $("enrichEnabled").checked,
    freshDelayMinutes: Number($("enrichFreshDelay").value),
    maxSizeBytes: Number($("enrichMaxSizeMb").value) * MB,
    throttleMs: Number($("enrichThrottleMs").value),
  });
  await settings.save("gate", { massCcRecipients: Number($("massCcRecipients").value) });
  await settings.save("me", { aliases: list($("aliases").value) });
  // Только имя сервера: схему и путь, если их вставили вместе с адресом, отрезаем.
  await settings.save("trueconf", {
    hosts: list($("tcHosts").value).map((h) => h.replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0].toLowerCase()),
  });

  $("saved").hidden = false;
  setTimeout(() => { $("saved").hidden = true; }, 2000);
});

$("tcCheck").addEventListener("click", () =>
  browser.tabs.create({ url: browser.runtime.getURL("src/ui/trueconf.html") }));

fill();
