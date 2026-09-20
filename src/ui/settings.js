// Настройки. Ни адреса модели, ни порогов разбора в коде нет — всё отсюда.

import * as settings from "../settings.js";

const $ = (id) => document.getElementById(id);

const LLM_NUM = ["concurrency", "bodyLimit", "timeoutMs"];
const SCAN_NUM = ["recentDays", "idleSeconds", "archiveRecheckDays",
  "targetPerWindow", "initialWindowDays", "minWindowDays",
  "maxWindowDays", "overlapDays", "floorYear", "throttleMs"];
const SCAN_BOOL = ["archiveOnIdle", "autoResume"];

async function fill() {
  const cfg = await settings.load();
  $("endpoint").value = cfg.llm.endpoint;
  $("model").value = cfg.llm.model;
  for (const k of LLM_NUM) $(k).value = cfg.llm[k];
  for (const k of SCAN_NUM) $(k).value = cfg.scan[k];
  $("excludeFolderTypes").value = cfg.scan.excludeFolderTypes.join(", ");
  for (const k of SCAN_BOOL) $(k).checked = cfg.scan[k];
}

/**
 * Разрешение на сеть запрашивается под конкретный адрес и только по нажатию
 * пользователя. Единственный сетевой адресат расширения — эндпоинт модели;
 * зашивать его в манифест нельзя, а просить `<all_urls>` — тем более.
 */
async function grantEndpoint(endpoint) {
  if (!endpoint) return true;
  const url = new URL(endpoint);
  const origin = `${url.protocol}//${url.host}/*`;
  if (await browser.permissions.contains({ origins: [origin] })) return true;
  return browser.permissions.request({ origins: [origin] });
}

$("save").addEventListener("click", async () => {
  $("error").textContent = "";
  $("saved").hidden = true;

  const endpoint = $("endpoint").value.trim().replace(/\/+$/, "");
  try {
    if (endpoint) new URL(endpoint);
  } catch {
    $("error").textContent = "Адрес эндпоинта разобрать не получилось.";
    return;
  }

  if (endpoint && !(await grantEndpoint(endpoint))) {
    $("error").textContent =
      "Без разрешения на этот адрес расширение не сможет обратиться к модели. " +
      "Остальные настройки сохранены.";
  }

  const llm = { endpoint, model: $("model").value.trim() };
  for (const k of LLM_NUM) llm[k] = Number($(k).value);

  const scan = {
    excludeFolderTypes: $("excludeFolderTypes").value
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
  for (const k of SCAN_NUM) scan[k] = Number($(k).value);
  for (const k of SCAN_BOOL) scan[k] = $(k).checked;

  await settings.save("llm", llm);
  await settings.save("scan", scan);

  $("saved").hidden = false;
  setTimeout(() => { $("saved").hidden = true; }, 2000);
});

fill();
