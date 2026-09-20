// Метки Thunderbird. Проходом T1 не используются — письма он только
// перечисляет, — но вызовы здесь приведены к API 115, чтобы под классификацию
// не осталось заведомо нерабочего кода.
//
// Под-неймспейса `browser.messages.tags` в 115 нет: он появился в TB 121.
// В 115 это `messages.listTags()` и `messages.createTag(key, tag, color)`
// (последняя — с TB 102).

export const TAGS = {
  task: { key: "r7t-task", tag: "Поручение", color: "#C4314B" },
  info: { key: "r7t-info", tag: "Информирование", color: "#6E7B8B" },
};

export async function ensureTags() {
  const existing = await browser.messages.listTags();
  for (const t of Object.values(TAGS)) {
    if (!existing.some((e) => e.key === t.key)) {
      await browser.messages.createTag(t.key, t.tag, t.color);
    }
  }
}

/** Добавляет метку, не затирая чужие. */
export async function addTag(messageId, currentTags, key) {
  const next = [...new Set([...(currentTags ?? []), key])];
  if (next.length === (currentTags ?? []).length) return false;
  await browser.messages.update(messageId, { tags: next });
  return true;
}
