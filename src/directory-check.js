// Проверка каталога (T5): видит ли расширение адресную книгу организации и
// какие сведения о человеке она отдаёт.
//
// Уровень отправителя по каталогу — это должность, подразделение и
// руководитель. Каталог полезен ровно настолько, насколько он отдаёт эти
// поля, поэтому проверка смотрит не на само наличие книги, а на поля в
// найденных карточках. В сводку попадают только числа и названия полей —
// ни имён, ни адресов, ни самого поискового запроса.
//
// Поиск в удалённой книге идёт в контроллер домена. Здесь он делается один
// раз по нажатию; в работе расширения — только для незнакомых адресов и
// отдельной медленной очередью.

const SERVICE_FIELDS = new Set(["BEGIN", "END", "VERSION", "UID", "PRODID", "REV"]);

// Поля, из которых выводится уровень. Названия — как в vCard и в старых
// свойствах карточек Thunderbird; LDAP-книги отдают их по своей схеме.
export const LEVEL_FIELDS = {
  title: ["TITLE", "JobTitle"],
  department: ["ORG", "Department"],
  role: ["ROLE"],
  manager: ["X-MANAGER", "MANAGER", "Manager"],
};

/** Названия полей карточки: из vCard и из прочих свойств. Значения не берём. */
export function fieldNames(contact) {
  const props = contact?.properties ?? {};
  const out = new Set();
  const vcard = props.vCard ?? props.vcard;
  if (typeof vcard === "string") {
    for (const line of vcard.split(/\r?\n/)) {
      const m = /^([A-Za-z][A-Za-z0-9-]*)(?:[;:])/.exec(line);
      if (m && !SERVICE_FIELDS.has(m[1].toUpperCase())) out.add(m[1].toUpperCase());
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === "vCard" || k === "vcard" || v == null || v === "") continue;
    out.add(k);
  }
  return out;
}

/**
 * @param {object} deps.browser  WebExtension API (нужно разрешение addressBooks)
 * @param {string} deps.query    имя или адрес коллеги для пробного поиска
 */
export async function checkDirectory({ browser, query = "" }) {
  const at = Date.now();
  const books = await browser.addressBooks.list(false);
  const summary = {
    at,
    books: books.length,
    remoteBooks: books.filter((b) => b.remote).length,
    readOnlyBooks: books.filter((b) => b.readOnly).length,
    localContacts: 0,
    search: null,
  };

  for (const b of books.filter((x) => !x.remote)) {
    try { summary.localContacts += (await browser.contacts.list(b.id)).length; } catch { /* книга недоступна */ }
  }

  if (query.trim()) {
    const probe = async (includeRemote) => {
      const t0 = Date.now();
      try {
        const found = await browser.contacts.quickSearch({
          searchString: query.trim(), includeLocal: !includeRemote, includeRemote,
        });
        const fields = new Set();
        for (const c of found) for (const f of fieldNames(c)) fields.add(f);
        const has = Object.fromEntries(Object.entries(LEVEL_FIELDS)
          .map(([k, names]) => [k, names.some((n) => fields.has(n) || fields.has(n.toUpperCase()))]));
        return { ms: Date.now() - t0, results: found.length, fields: [...fields].sort(), levelFields: has };
      } catch (e) {
        return { ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
      }
    };
    summary.search = { local: await probe(false), remote: await probe(true) };
  }
  return summary;
}
