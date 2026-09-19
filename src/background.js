// Очередь сканирования. Главное свойство: проход по ящику на десятки тысяч
// писем переживает закрытие клиента и продолжается с места остановки.
//
// Порядок обработки письма:
//   заголовки -> дешёвые признаки -> гейт -> (опционально) модель -> запись

import * as db from "./db.js";
import { extract, gate, normalize } from "./features.js";
import { LlmClient } from "./llm.js";
import { PROMPT_VERSION } from "./prompts/classify.js";

const PAGE_SIZE = 200;
const TAGS = {
  task: { key: "r7t-task", tag: "Поручение", color: "#C4314B" },
  info: { key: "r7t-info", tag: "Информирование", color: "#6E7B8B" },
};

let running = false;

async function settings() {
  const s = await browser.storage.local.get({
    endpoint: "http://127.0.0.1:8000",
    model: "qwen2.5-14b-instruct",
    concurrency: 3,
    bodyLimit: 4000,
  });
  return s;
}

async function ensureTags() {
  const existing = await browser.messages.tags.list();
  for (const t of Object.values(TAGS)) {
    if (!existing.some((e) => e.key === t.key)) {
      await browser.messages.tags.create(t.key, t.tag, t.color);
    }
  }
}

async function myAddresses() {
  const accounts = await browser.accounts.list();
  const ids = new Set();
  for (const a of accounts) {
    for (const i of a.identities ?? []) ids.add(normalize(i.email));
  }
  return ids;
}

/**
 * Полный проход. scanId позволяет держать несколько независимых проходов
 * (первичная индексация и инкрементальная доиндексация).
 */
export async function scan(scanId = "full") {
  if (running) return;
  running = true;
  try {
    const cfg = await settings();
    const llm = new LlmClient(cfg);
    const me = await myAddresses();
    const meId = [...me][0] ?? "";
    await ensureTags();

    const state = (await db.checkpoint.load(scanId)) ?? {
      folderIndex: 0, processed: 0, folders: null,
    };

    if (!state.folders) {
      state.folders = await listFolders();
      await db.checkpoint.save(scanId, state);
    }

    for (; state.folderIndex < state.folders.length; state.folderIndex++) {
      const folder = state.folders[state.folderIndex];
      let page = await browser.messages.query({ folder, headerMessageId: null });

      while (page) {
        await processPage(page.messages, { llm, meId, cfg });
        state.processed += page.messages.length;
        await db.checkpoint.save(scanId, state);

        if (!page.id) break;
        page = await browser.messages.continueList(page.id);
      }
    }

    await db.checkpoint.save(scanId, { ...state, done: true });
  } finally {
    running = false;
  }
}

async function listFolders() {
  const out = [];
  for (const account of await browser.accounts.list()) {
    walk(account.folders ?? [], out);
  }
  return out;
  function walk(folders, acc) {
    for (const f of folders) {
      if (!["trash", "junk", "templates"].includes(f.type)) acc.push(f);
      if (f.subFolders?.length) walk(f.subFolders, acc);
    }
  }
}

async function processPage(messages, { llm, meId, cfg }) {
  const rows = [];
  const verdicts = [];

  for (const hdr of messages) {
    if (await db.get("verdicts", hdr.id)) continue;   // уже разобрано

    const full = await browser.messages.getFull(hdr.id);
    const f = extract(hdr, full, meId);

    let verdict = gate(f);
    if (!verdict) {
      const body = extractBody(full).slice(0, cfg.bodyLimit);
      try {
        verdict = await llm.classify({
          subject: f.subject, from: f.fromId, body, features: f,
          senderLevel: (await db.get("people", f.fromId))?.level ?? null,
        });
      } catch (e) {
        console.warn("classify failed", hdr.id, e);
        continue;   // оставляем на следующий проход
      }
    }

    rows.push({ id: hdr.id, ...f });
    verdicts.push({
      messageId: hdr.id,
      label: verdict.label,
      confidence: verdict.confidence,
      reason: verdict.reason,
      task: verdict.task ?? null,
      expiresAt: verdict.staleDays
        ? f.date + verdict.staleDays * 86400000 : null,
      promptVersion: PROMPT_VERSION,
      features: f,
    });

    const tag = TAGS[verdict.label];
    if (tag) {
      await browser.messages.update(hdr.id, {
        tags: [...new Set([...(hdr.tags ?? []), tag.key])],
      });
    }
  }

  if (rows.length) await db.putMany("messages", rows);
  if (verdicts.length) await db.putMany("verdicts", verdicts);
}

function extractBody(full) {
  const parts = [];
  (function walk(p) {
    if (p.body && p.contentType?.startsWith("text/plain")) parts.push(p.body);
    (p.parts ?? []).forEach(walk);
  })(full);
  return parts.join("\n").trim();
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg?.cmd === "scan") return scan(msg.scanId);
  if (msg?.cmd === "export") return db.exportAll();
  return undefined;
});
