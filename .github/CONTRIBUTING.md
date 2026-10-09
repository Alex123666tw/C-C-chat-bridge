# 貢獻方式

[專案用途](../README.md) · [操作說明](../docs/usage.md) · [介面與限制](../docs/interfaces.md)

本專案的目的是讓 Codex 與 Claude Code 透過原生跨聊天介面互相傳訊及接收回覆。修改應接回正常 CLI／MCP 入口，保留來源標示與明確的送達狀態。

## 回報問題

一般問題可使用 GitHub Issues。請提供 Node、Windows 與兩個客戶端版本、使用入口、已去識別的啟動參數、預期與實際狀態，以及最小重現。區分「工具接受派送」「收到原生回覆」與「取得本次完整 final」；說明資料來自真實客戶端還是替身測試。

不要貼私人聊天、registry key／token、個人路徑、實際 pipe URI、完整 runtime 或 `tests/output/`。可用占位值保留錯誤的結構。安全漏洞請依 [SECURITY](SECURITY.md) 私下回報，不在公開 issue 公布細節。

## 本機開發與測試

需要 Node.js 20 以上。產品使用 Node 內建模組，沒有額外 npm 套件；不用執行 `npm install`。

```powershell
npm test
```

`npm test` 執行 Node test runner。測試建立隔離的原生管道及聊天資料替身，涵蓋正式 CLI、MCP、adapter 與回程路由；不需要帳戶、不呼叫模型、不向既有聊天傳訊。這能證明資料與錯誤處理，不能代替 Desktop MCP、真實客戶端、跨主機或長時間使用驗收。

依改動執行受影響的測試即可；檔案格式、正常入口或原生格式改變時，一併更新相關操作說明。維持現有 ESM `.mjs`、Node 內建 API 與附近程式風格，不引入與交付效果無關的依賴或抽象。

## 選用的真模型往返測試

`src/cli-pair-test.mjs` 會呼叫真模型、使用帳戶額度並寫入本機測試產物。僅在有明確授權、帳戶已可用及原生 Windows CLI 可執行時，手動設定四個必填環境變數：

```powershell
$env:PAIR_CODEX_EXE = 'C:\tools\codex.exe'
$env:PAIR_CLAUDE_EXE = 'C:\tools\claude.exe'
$env:PAIR_CODEX_MODEL = 'YOUR_AVAILABLE_CODEX_MODEL'
$env:PAIR_CLAUDE_MODEL = 'YOUR_AVAILABLE_CLAUDE_MODEL'
node src/cli-pair-test.mjs
```

請填實際可執行檔及自己的可用模型名稱；沒有預設模型。這個 probe 啟動兩個**獨立 CLI 程序**，用隔離 nonce 核對 Claude callback 與 Codex 回覆，清理自己建立的程序與通訊資料。它不是 Codex Desktop 的原生 MCP 雙向驗收，也不驗證 App 已連線的遠端聊天。

結果輸出至 gitignored 的 `tests/output/cli-pair-*`，可能含本機路徑與模型互動內容；不要直接提交或貼到 issue／PR。正常使用變更仍需在已授權範圍以自己的客戶端與目的確認，對外只附去識別的結果及其證明範圍。

## 提交修改

Fork 後用分支送 PR。提交訊息簡短說明具體改變；PR 交代使用者會遇到的問題、修改後行為、實際確認方法及尚未確認的部分。小改動不必附大量紀錄。涉及接線、schema 或狀態時，請更新對應深入文件與範例。

提交前檢查 diff，確保沒有私人聊天、runtime、認證、本機專用設定或內部工作資料。`runtime/`、`tests/output/`、`.work/` 與環境檔已 gitignore，但新檔案與 Git 歷史仍需自行核對。不要為通過測試把摘要當答覆、取消來源核對，或把未知送達改報成功。

貢獻內容依本專案 [MIT License](../LICENSE) 提供。
