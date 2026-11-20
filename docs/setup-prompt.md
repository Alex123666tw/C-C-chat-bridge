# Let your model configure its own client

English · [繁體中文](#繁體中文)

Open this project in Codex, Claude Code, or Antigravity CLI (`agy`) and give the model the prompt below. Run it once per client you want to connect.

```text
Set up this project's C-C chat bridge in the MCP client you are currently using, so you can discover and read chats and exchange messages through the supported clients' native chat interfaces.

Read README.md, docs/usage.md, and the example for your client in examples/. Confirm the project path, Node.js, the actual Codex owner chat ID, and its current native pipe. Reuse and verify existing configuration or connection values; do not invent IDs or pipe paths. Ask only for necessary values you cannot obtain yourself.

Replace the example placeholders with real values and merge the configuration into your own client's appropriate MCP settings, preserving other settings. Use absolute paths and the documented tool timeouts. Keep personal connection data local and out of Git. Do not modify the other client's settings.

Use your actual MCP connection to list the bridge tools and call the list tool for each requested chat source (Codex, Claude Code, or Antigravity CLI). If the user needs to reload the client, give precise instructions. Before testing message delivery, obtain user authorization for the destination chat and test content, and distinguish dispatch, a received reply, and an unknown outcome as documented.

Briefly report the configuration location, the capabilities you verified, and any remaining connection problem.
```

Codex can usually obtain the owner and pipe values from its current Desktop chat. Claude Code and Antigravity CLI can reuse the values obtained by an authorized Codex chat using the [setup guide](usage.md#取得-codex-來源與管道).

## 繁體中文

在本專案目錄開啟 Codex、Claude Code 或 Antigravity CLI（`agy`），把以下提示交給模型。每個想接入的客戶端各執行一次。

```text
請把這個專案的 C-C 聊天橋接配置到你自己目前使用的 MCP 客戶端，讓你能透過支援的客戶端原生聊天介面列出、讀取聊天及互傳訊息。

先讀 README.md、docs/usage.md 與 examples/中對應你客戶端的範例，確認專案路徑、Node.js，以及有效的 Codex owner 聊天 ID 和當次原生管道。已有設定或接線資料就沿用並核對，不猜 ID 或管道；缺少你無法自行取得的值時，只詢問必要資訊。

將範例改成實際值後，合併到你自己客戶端適用的 MCP 設定，保留其他既有設定。使用絕對路徑，依文件設定工具逾時；個人接線資料留在本機，不提交到倉庫。不要替另一個客戶端修改設定。

用實際的 MCP 連線列出橋接工具，並逐一呼叫使用者要連接的聊天來源（Codex、Claude Code 或 Antigravity CLI）的列表工具。若需要使用者重載客戶端，交代具體操作。若要傳訊驗證，先取得使用者對目的聊天與測試內容的授權，並按文件區分派送、收到回覆與未知結果。

最後簡短回報設定位置、已確認能使用的功能，以及尚未連通的原因。
```

Codex 通常能從目前 Desktop 聊天取得 owner 與管道。Claude Code 和 Antigravity CLI 可沿用由已授權的 Codex 聊天依[使用說明](usage.md#取得-codex-來源與管道)取得的值。
