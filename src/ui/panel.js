// TODO: граф и список поручений. Пока только запуск прохода и выгрузка.

const status = document.getElementById("status");

document.getElementById("scan").addEventListener("click", async () => {
  status.textContent = "Разбор запущен…";
  await browser.runtime.sendMessage({ cmd: "scan", scanId: "full" });
  status.textContent = "Готово.";
});

document.getElementById("export").addEventListener("click", async () => {
  const data = await browser.runtime.sendMessage({ cmd: "export" });
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  await browser.downloads.download({ url, filename: "r7-triage-export.json" });
});
