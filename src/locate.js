// Письмо из базы → письмо в клиенте, чтобы открыть его или ответить.
//
// Номер письма в клиенте живёт одну сессию (keys.js), поэтому для каждого
// действия письмо ищется заново: в папках, где его видел проход по ящику,
// по диапазону дат вокруг его даты и сверкой по устойчивому ключу. Запрос
// `headerMessageId` здесь не годится: в 115 он перебирает папку целиком на
// каждое письмо, а поиск по дате сужает выдачу тем же перебором за раз.

import { messageKey, parseFolderKey } from "./keys.js";

const PAD_MS = 86400000;

/**
 * @param {object} browser WebExtension API
 * @param {object} row запись письма из хранилища `messages`
 * @returns {Promise<object|null>} MessageHeader текущей сессии
 */
export async function findHeader(browser, row) {
  for (const loc of row.locations ?? []) {
    try {
      let page = await browser.messages.query({
        folder: parseFolderKey(loc),
        fromDate: new Date(row.date - PAD_MS),
        toDate: new Date(row.date + PAD_MS),
      });
      while (page) {
        for (const hdr of page.messages ?? []) if (messageKey(hdr) === row.id) return hdr;
        if (!page.id) break;
        page = await browser.messages.continueList(page.id);
      }
    } catch {
      // Папку могли удалить — пробуем следующее место хранения.
    }
  }
  return null;
}
