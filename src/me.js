// Свои адреса. На них держатся признаки inTo / inCc / fromMe.
//
// Источники — личности учётных записей Thunderbird и список из настроек.
// Второй нужен потому, что клиент знает не всё: алиасы Exchange,
// делегированные ящики и списки рассылки, в которых состоит пользователь,
// личностями обычно не заведены. Письмо, пришедшее на список рассылки
// отдела, адресовано человеку ровно так же, как письмо на его адрес.
//
// Набор нигде не сохраняется в записях писем: признаки выводятся при чтении
// (features.js), и уточнение списка не требует повторного прохода по ящику.

import { normalizeAddress } from "./keys.js";

/**
 * @param {object} browser WebExtension API
 * @param {string[]} aliases дополнительные адреса из настроек
 * @returns {Promise<Set<string>>}
 */
export async function myAddresses(browser, aliases = []) {
  const out = new Set();
  // Без папок: дерево папок большого ящика здесь не нужно, а собирать его
  // дорого. `includeFolders` есть с TB 96.
  const accounts = await browser.accounts.list(false);
  for (const account of accounts) {
    for (const identity of account.identities ?? []) {
      const email = normalizeAddress(identity.email);
      if (email) out.add(email);
    }
  }
  for (const a of aliases) {
    const email = normalizeAddress(a);
    if (email) out.add(email);
  }
  return out;
}
