// Настройки. Ни адреса модели, ни порогов разбора в коде нет — всё отсюда.

import * as settings from "../settings.js";

const $ = (id) => document.getElementById(id);

const LLM_NUM = ["concurrency", "bodyLimit", "timeoutMs"];
const SCAN_NUM = ["recentDays", "idleSeconds", "archiveRecheckDays",
  "targetPerWindow", "initialWindowDays", "minWindowDays",
  "maxWindowDays", "overlapDays", "floorYear", "throttleMs"];
const SCAN_BOOL = ["archiveOnIdle", "autoResume"];
const CASES_NUM = ["periodDays", "newDays", "historyLimit", "subjectJoinDays"];
const CASES_BOOL = ["joinByObject"];
const GATE_BOOL = ["ccOnlyIsInfo", "unaddressedIsInfo"];
const SENDERS_NUM = ["minLetters", "broadcastRecipients"];
const DIR_NUM = ["cacheDays", "pauseMs", "maxPerSession"];
const ARCHIVE_NUM = ["afterDays", "scanDays"];
const ARCHIVE_BOOL = ["keepUnread", "keepFlagged", "keepAwaiting", "keepWithAttachments"];
const DIR_BOOL = ["enabled", "includeRemote"];
const MB = 1048576;

const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const up = (k) => k[0].toUpperCase() + k.slice(1);

/**
 * Папки всех учётных записей для выбора архива. Дерево обходится целиком:
 * в Thunderbird 115 у папки нет идентификатора, устойчивая пара — учётная
 * запись и путь.
 */
async function fillFolders(selected) {
  const box = $("archiveTarget");
  const accounts = await browser.accounts.list(true);
  const walk = (folders, account) => {
    for (const f of folders ?? []) {
      if (f.path && f.path !== "/") {
        const value = `${f.accountId ?? account.id}|${f.path}`;
        box.append(new Option(`${account.name}: ${f.path}`, value,
          false, value === selected));
      }
      walk(f.subFolders ?? f.folders, account);
    }
  };
  for (const account of accounts) walk(account.folders, account);
}

async function fill() {
  const cfg = await settings.load();
  $("endpoint").value = cfg.llm.endpoint;
  $("model").value = cfg.llm.model;
  $("apiKey").value = cfg.llm.apiKey;
  for (const k of LLM_NUM) $(k).value = cfg.llm[k];
  for (const k of SCAN_NUM) $(k).value = cfg.scan[k];
  $("excludeFolderTypes").value = cfg.scan.excludeFolderTypes.join(", ");
  for (const k of SCAN_BOOL) $(k).checked = cfg.scan[k];

  $("enrichEnabled").checked = cfg.enrich.enabled;
  $("enrichFreshDelay").value = cfg.enrich.freshDelayMinutes;
  $("enrichMaxSizeMb").value = Math.round(cfg.enrich.maxSizeBytes / MB);
  $("enrichThrottleMs").value = cfg.enrich.throttleMs;
  $("massCcRecipients").value = cfg.gate.massCcRecipients;
  for (const k of CASES_NUM) $(`cases${up(k)}`).value = cfg.cases[k];
  for (const k of CASES_BOOL) $(`cases${up(k)}`).checked = cfg.cases[k];
  for (const k of GATE_BOOL) $(`gate${up(k)}`).checked = cfg.gate[k];
  for (const k of SENDERS_NUM) $(`senders${up(k)}`).value = cfg.senders[k];
  $("sendersSystemSenders").value = cfg.senders.systemSenders.join(", ");
  $("sendersTemplateSharePct").value = Math.round(cfg.senders.templateShare * 100);
  $("gateActionWords").value = cfg.gate.actionWords.join(", ");
  for (const k of DIR_NUM) $(`dir${up(k)}`).value = cfg.directory[k];
  for (const k of DIR_BOOL) $(`dir${up(k)}`).checked = cfg.directory[k];
  for (const k of ARCHIVE_NUM) $(`archive${up(k)}`).value = cfg.archive[k];
  for (const k of ARCHIVE_BOOL) $(`archive${up(k)}`).checked = cfg.archive[k];
  await fillFolders(cfg.archive.target ? `${cfg.archive.target.accountId}|${cfg.archive.target.path}` : "");
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

  const llm = { endpoint, model: $("model").value.trim(), apiKey: $("apiKey").value.trim() };
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
  const gate = {
    massCcRecipients: Number($("massCcRecipients").value),
    actionWords: list($("gateActionWords").value).map((x) => x.toLowerCase()),
  };
  for (const k of GATE_BOOL) gate[k] = $(`gate${up(k)}`).checked;
  await settings.save("gate", gate);

  const cases = {};
  for (const k of CASES_NUM) cases[k] = Number($(`cases${up(k)}`).value);
  for (const k of CASES_BOOL) cases[k] = $(`cases${up(k)}`).checked;
  await settings.save("cases", cases);

  const senders = {
    systemSenders: list($("sendersSystemSenders").value).map((x) => x.toLowerCase()),
    templateShare: Number($("sendersTemplateSharePct").value) / 100,
  };
  for (const k of SENDERS_NUM) senders[k] = Number($(`senders${up(k)}`).value);
  await settings.save("senders", senders);

  const directory = {};
  for (const k of DIR_NUM) directory[k] = Number($(`dir${up(k)}`).value);
  for (const k of DIR_BOOL) directory[k] = $(`dir${up(k)}`).checked;
  await settings.save("directory", directory);
  const target = $("archiveTarget").value;
  const archive = {
    target: target ? { accountId: target.slice(0, target.indexOf("|")), path: target.slice(target.indexOf("|") + 1) } : null,
  };
  for (const k of ARCHIVE_NUM) archive[k] = Number($(`archive${up(k)}`).value);
  for (const k of ARCHIVE_BOOL) archive[k] = $(`archive${up(k)}`).checked;
  await settings.save("archive", archive);

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
