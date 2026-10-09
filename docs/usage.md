# 安裝與使用

[回到首頁](../README.md) · [介面與限制](interfaces.md) · [安全政策](../.github/SECURITY.md)

本工具讓 Codex 與 Claude Code 接上對方的原生跨聊天介面。先完成本機接線、讀取確認，再對已獲使用者授權的目的聊天傳訊。

## 環境需求

- Windows、Node.js 20 以上；使用 Node 內建模組，無須 `npm install`。
- 正在執行的 Codex Desktop，及允許橋接使用其內部工具的來源 Codex 聊天。
- 若要傳訊給 Claude，目的必須是本機正在執行、具有原生訊息管道的 Claude Code session。只有歷史檔案的聊天可讀取，不能直接收訊。
- 執行橋接的 Windows 帳號必須能存取原生管道與 Claude Code 的本機 registry。請閱讀[信任與資料範圍](interfaces.md#信任與資料範圍)。

內部介面不是穩定的公開 API。最初核對的版本為 Codex Desktop `26.1002.7124.0` 與 Claude Code `2.1.289`；這不是所有版本的相容保證。

下載或 clone 專案後，在專案目錄執行：

```powershell
node --version
node src/cli.mjs --help
```

以下 shell 範例均從專案目錄執行。MCP 客戶端設定則使用絕對路徑，避免客戶端的工作目錄不同。

## 取得 Codex 來源與管道

在**實際授權橋接的 Codex 聊天**中，請該聊天執行以下 PowerShell，取得它當次的環境值：

```powershell
[pscustomobject]@{
  OwnerThreadId = $env:CODEX_THREAD_ID
  PipePath = $env:CODEX_APP_TOOLS_PIPE_PATH
}
```

`OwnerThreadId` 是來源聊天，不是準備傳訊的目的聊天。橋接會以它作為原生工具呼叫的 owner；可見聊天與跨主機能力沿用該 owner 的原生範圍。`PipePath` 必須逐字使用當次值。

若任一值為空，回到授權的 Codex Desktop 聊天確認環境；不要猜 owner、掃描其他管道或用任意 session ID 代替。一般外部終端不一定有這兩個環境變數。`CODEX_OWNER_THREAD_ID` 是本工具 MCP 可選的設定來源，不會自動從 `CODEX_THREAD_ID` 推定。

Codex App 重啟後，重新取得有效管道並更新設定，再重新連接 MCP。範例中的 owner、pipe 與本機路徑都是占位值，請只保存在自己的設定中。

## 先確認可讀取

把以下占位值換成剛取得的來源與管道：

```powershell
node src/cli.mjs codex tools --owner-thread "YOUR_CODEX_OWNER_THREAD_ID" --pipe "YOUR_CURRENT_CODEX_PIPE_PATH"
node src/cli.mjs codex threads --owner-thread "YOUR_CODEX_OWNER_THREAD_ID" --pipe "YOUR_CURRENT_CODEX_PIPE_PATH" --limit 10
node src/cli.mjs claude sessions
```

前兩個命令應回傳 `status: "ok"` 與原生結果。第一個命令列出原生工具，第二個列出近期與釘選聊天。`claude sessions` 列出 registry 中的候選 session，不保證每筆程序仍存活；MCP 的 `claude_list_chats` 另提供 `live` 與 `sendAvailable`。

先用列表確認目的聊天的 ID、名稱與 host；不要從標題猜 ID。遠端 Codex 必須使用列表回傳的 `hostId`。從 CLI 讀取選定的 Codex 聊天：

```powershell
node src/cli.mjs codex read --owner-thread "YOUR_CODEX_OWNER_THREAD_ID" --pipe "YOUR_CURRENT_CODEX_PIPE_PATH" --target-thread "YOUR_TARGET_THREAD_ID" --host-id "YOUR_LISTED_HOST_ID" --limit 3
```

本機目的可省略 `--host-id`，沿用原生預設。讀取失敗時先修正接線，不先用傳訊測試連線。

## 接入兩端 MCP

本工具提供 stdio MCP server，**不會自動安裝或修改任何客戶端設定**。Codex 與 Claude 各自啟動一個 server 程序；可使用同一組已授權 owner 與當次 pipe，但 inbox 不會在兩個程序間共用。

### Codex 設定

把 [Codex 範例](../examples/codex-mcp.example.toml) 合併到自己的 `%USERPROFILE%\.codex\config.toml`；若已有同名設定，編輯該段，不要建立重複 TOML table：

```toml
[mcp_servers.local_cross_chat]
command = "node"
args = ["C:/tools/c-c-chat-bridge/src/mcp-server.mjs", "--owner-thread", "YOUR_CODEX_OWNER_THREAD_ID", "--pipe", "YOUR_CURRENT_CODEX_PIPE_PATH"]
tool_timeout_sec = 660
```

將路徑改成實際安裝位置。如果客戶端找不到 `node`，`command` 改用 `node.exe` 的絕對路徑。`tool_timeout_sec` 是 Codex 客戶端設定，讓一次工具呼叫有時間等候橋接預設的 600 秒結果；若改變橋接等待時間，也要相應調整客戶端上限。[OpenAI 官方 MCP 說明](https://developers.openai.com/codex/mcp)列出設定位置與客戶端逾時選項。

用 `codex mcp get local_cross_chat` 檢查儲存的設定，在客戶端重新連接後確認能看到橋接工具。設定存在只證明設定已寫入，仍須實際呼叫讀取工具。

### Claude Code 設定

把 [Claude 範例](../examples/claude-mcp.example.json) 的 server entry 合併到**使用此 MCP 的專案根目錄** `.mcp.json`：

```json
{
  "mcpServers": {
    "local-cross-chat": {
      "command": "node",
      "args": [
        "C:/tools/c-c-chat-bridge/src/mcp-server.mjs",
        "--owner-thread", "YOUR_CODEX_OWNER_THREAD_ID",
        "--pipe", "YOUR_CURRENT_CODEX_PIPE_PATH"
      ],
      "timeout": 660000
    }
  }
}
```

路徑與參數需替換成實值；JSON 的 Windows 反斜線要寫成 `\\`，使用 `/` 的路徑可避免路徑跳脫問題。這裡的 `timeout` 以毫秒計，是 Claude 客戶端每次工具呼叫的上限。[Claude 官方 MCP 說明](https://code.claude.com/docs/en/mcp)說明專案設定與使用確認。

這份含個人接線資訊的 `.mcp.json` 請留在本機。若不希望使用專案共享設定，可依 `claude mcp add --help` 選用 `local` 或 `user` scope；兩者由 Claude 自己管理。啟動 Claude 後依其介面確認 MCP，使用 `/mcp` 查看連線，再呼叫讀取工具。工具可見與 MCP 已連線仍不代表使用者已授權任意傳訊。

### 只啟動 server 不會開聊天

```powershell
node src/mcp-server.mjs --owner-thread "YOUR_CODEX_OWNER_THREAD_ID" --pipe "YOUR_CURRENT_CODEX_PIPE_PATH"
```

此命令等待客戶端的 MCP JSON-RPC 輸入。正常使用由客戶端管理 stdin/stdout；stdout 留給協定，不是互動式聊天視窗。啟動參數錯誤時 stderr 輸出 `MCP_STARTUP_FAILED`。

## 從 MCP 傳訊與收回覆

以下是工具的 JSON arguments，工具名稱可能被客戶端加上 server 前綴。完整契約見[工具介面](interfaces.md#工具介面)。

### Claude 請 Codex 工作

先呼叫 `codex_list_threads` 或 `codex_list_archived_threads`，再用 `codex_read_thread` 確認目的。對使用者選定且授權的目的，呼叫 `codex_request`：

```json
{
  "threadId": "YOUR_TARGET_THREAD_ID",
  "hostId": "YOUR_LISTED_HOST_ID",
  "prompt": "請回覆這次測試字串：BRIDGE_HELLO_123。不要讀寫檔案或呼叫其他工具。",
  "timeoutMs": 600000,
  "pollMs": 2000
}
```

本機目的可省略 `hostId`。`codex_request` 會等待目的空閒後只傳送一次，追蹤本次新回合的完整最終答覆。`completed` 回傳 `turnId`、`text` 與 `msgId`；它表示觀察到該答覆，不代表答覆中的工作結論一定正確。

只需要派送時可用 `codex_send_message_to_thread`，但 `accepted` 尚未確認完成。不要把 `codex_read_thread` 的摘要或 `codex_wait_threads` 的狀態文字當成精確的本次答覆。

### Codex 請 Claude 回覆

1. 用 `claude_list_chats` 找到 `live: true`、`sendAvailable: true` 的精確 `sessionId`。可先用 `claude_read_chat` 確認歷史與上下文。
2. 呼叫 `claude_send_message`：

   ```json
   {
     "sessionId": "YOUR_LIVE_CLAUDE_SESSION_UUID",
     "message": "請用原生 SendMessage 回覆收到 BRIDGE_HELLO_123；to 必須等於本則 cross-session-message 的 from。不要讀寫檔案或呼叫其他工具。"
   }
   ```

3. 保持同一 MCP 連線，呼叫 `claude_read_inbox`：

   ```json
   { "sessionId": "YOUR_LIVE_CLAUDE_SESSION_UUID", "offset": 0, "limit": 20 }
   ```

`claude_send_message` 建立本程序的 callback 並回傳 `callbackUri`。目的 Claude 需使用自己的原生 `SendMessage`，將 `to` 設為收到的 `cross-session-message` 的 `from`，以 `message` 傳回內容。一般 final 顯示在 Claude 自己的聊天，不會自動進入橋接 inbox。

`submitted_unconfirmed` 只表示已寫入原生管道。Inbox 的 `receipt` 可用 `originalMsgId` 核對原始訊息；`message` 的 `correlation: "source_session_only"` 只確認來源 session，不能直接斷言對應某個請求。可在自己的測試訊息加入唯一字串，再核對回覆內容。

依 `nextOffset` 繼續讀 inbox。每個程序最多保留 1000 件，`retainedFrom` 表示目前仍保留的最早 index；重新啟動程序後 inbox 消失。不要在另一客戶端、另一個新程序或新連線的 inbox 尋找舊程序收到的回覆。

## MCP 啟動設定

所有參數都是 `--名稱 值`，不接受重複選項或未知名稱。

| 選項 | JSON config 欄位 | 環境 fallback／預設 | 用途 |
|---|---|---|---|
| `--owner-thread` | `codexOwnerThreadId` | `CODEX_OWNER_THREAD_ID`；必填 | 原生工具來源 owner |
| `--pipe` | `codexPipePath` | `CODEX_APP_TOOLS_PIPE_PATH`；必填 | 當次 Codex 原生管道 |
| `--config` | — | 無 | 讀取 JSON object 設定檔 |
| `--timeout-ms` | `timeoutMs` | `30000` | 每次 Codex 原生 RPC 的逾時 |
| `--target-thread` | `codexTargetThreadId` | 無 | Codex request 的預設目的 |
| `--host-id` | `codexTargetHostId` | 原生預設 host | Codex request 的預設 host |
| `--result-timeout-ms` | `resultTimeoutMs` | `600000` | 等候目的空閒及本次結果的總預算 |
| `--poll-ms` | `resultPollMs` | `2000` | Codex 結果的唯讀輪詢間隔 |

優先序為**啟動參數 → JSON config → 表中指定的環境變數 → 預設值**。只有 owner 與 pipe 有環境 fallback。`codex_request` 的 `threadId`、`hostId`、`timeoutMs`、`pollMs` arguments 優先於其對應 server 預設；其餘原生 Codex 工具仍以原生 schema 的必填欄位為準。

ID、pipe 及設定的 host 必須是非空字串。三個時間值都須為正整數；`timeoutMs` 與 `pollMs` 上限為 `2147483647`。設定檔路徑相對於啟動 server 的工作目錄，建議使用絕對路徑。

本機 JSON 範例，可存於 gitignored 的 `runtime/config.json`：

```json
{
  "codexOwnerThreadId": "YOUR_CODEX_OWNER_THREAD_ID",
  "codexPipePath": "YOUR_CURRENT_CODEX_PIPE_PATH",
  "codexTargetThreadId": "YOUR_TARGET_THREAD_ID",
  "codexTargetHostId": "YOUR_LISTED_HOST_ID",
  "timeoutMs": 30000,
  "resultTimeoutMs": 600000,
  "resultPollMs": 2000
}
```

MCP 入口沒有 `--registry-dir`、`--projects-dir` 或 Claude 逾時啟動選項。需要自訂 Claude 目錄的程式使用者可透過 [provider factory](interfaces.md#程式嵌入) 傳入；把那些欄位加進 MCP JSON config 不會改變 Claude provider。

## CLI 與原生 callback

CLI 輸出 JSON。訊息從 `--message-file` 指定的 UTF-8 檔案讀取，省略時讀 stdin；互動式終端必須提供其中一種。傳訊仍需使用者授權。

### 直接 Codex CLI

| 命令 | 作用 |
|---|---|
| `codex tools` | 列出原生工具與當次 schema |
| `codex threads` | 原生近期與釘選列表；`--limit` 為 1–50，沒有清單分頁 |
| `codex read` | `--target-thread` 必填；`--limit` 為 1–10 回合，可用回傳的 `--cursor` 讀更舊回合 |
| `codex send` | `--target-thread` 必填；回傳 `accepted`，不等待結果 |

這四個命令使用 `--owner-thread`，`--pipe` 可由 `CODEX_APP_TOOLS_PIPE_PATH` 補入。另可指定 `--timeout-ms`；read/send 使用 `--host-id`。只有取得實際 caller turn metadata 時才提供 `--turn-id`，不要自行編造。

```powershell
node src/cli.mjs codex send --owner-thread "YOUR_CODEX_OWNER_THREAD_ID" --pipe "YOUR_CURRENT_CODEX_PIPE_PATH" --target-thread "YOUR_TARGET_THREAD_ID" --message-file "runtime/request.txt"
```

### 綁定與單次等待

`bridge bind` 把接線寫入 JSON，不會替客戶端安裝 MCP，也不會發送訊息。owner、target 與 pipe 必填；只有要啟動 callback 路由時才必須提供 Claude session：

```powershell
node src/cli.mjs bridge bind --owner-thread "YOUR_CODEX_OWNER_THREAD_ID" --target-thread "YOUR_TARGET_THREAD_ID" --pipe "YOUR_CURRENT_CODEX_PIPE_PATH" --session-id "YOUR_LIVE_CLAUDE_SESSION_UUID" --config "runtime/config.json"
node src/cli.mjs bridge request --config "runtime/config.json" --message-file "runtime/request.txt"
```

`bridge request` 只對設定的 Codex 目的工作，等待本次完整 final，輸出 `completed` 或 `failed`／`unknown`；不啟動 callback，不需要 Claude session。遠端目的在 bind 時用 `--target-host-id`，不使用 MCP 的 `--host-id` 名稱。

### 常駐 callback 路由

若要讓 Claude 的原生 `SendMessage` 直接把新工作送到固定 Codex 目的，在 bind 時加入 `--auto-reply true`，然後：

```powershell
node src/cli.mjs bridge serve --config "runtime/config.json" --state "runtime/state.json"
```

`serve` 確認設定的 Claude session 恰好有一筆匹配，啟動自己的 callback 接收器，輸出 `ready` 與 `callbackUri`，並寫入本機 state 與同目錄的 `events.jsonl`。保持此程序執行；可在另一個終端查看或傳訊：

```powershell
node src/cli.mjs bridge status --state "runtime/state.json"
node src/cli.mjs bridge send --state "runtime/state.json" --message-file "runtime/request.txt"
```

`bridge send` 傳給 state 中的 Claude session，回程使用該 daemon 的 callback。Claude 若要傳新工作給 Codex，用原生 `SendMessage(to = 收到訊息的 from, message = 新工作)`。Daemon 只轉送設定 session 的來源，按序處理且去重；`autoReply: true` 才等待精確 Codex final 並回傳給 Claude。預設 `false` 只派送，不等待或自動回傳結果。結果回傳訊息已註明無需確認回信，避免把確認訊息再次當成工作。

`bridge status` 的 `running` 只確認 state PID 可見，不是全鏈路健康檢查。用 Ctrl+C 結束 `serve` 時會排空已接收工作並清理自己建立的 callback key 與 state；events 保留在本機。

### Bridge 設定與選項

| JSON 欄位 | bind 選項 | 預設／用途 |
|---|---|---|
| `codexOwnerThreadId` | `--owner-thread` | 必填來源 owner |
| `codexTargetThreadId` | `--target-thread` | 必填 Codex 目的 |
| `codexPipePath` | `--pipe` | 缺省取 `CODEX_APP_TOOLS_PIPE_PATH`；仍須有效 |
| `codexTargetHostId` | `--target-host-id` | 省略沿用原生 host |
| `claudeSessionId` | `--session-id` | `serve` 必填；精確 session UUID |
| `claudeRegistryDir` | `--registry-dir` | 預設 `%USERPROFILE%\.claude\sessions` |
| `autoReply` | `--auto-reply true/false` | 預設 `false`；callback 工作等待／回傳結果 |
| `resultTimeoutMs` | `--result-timeout-ms` | 預設 `600000`；等待空閒及結果的總預算 |
| `resultPollMs` | `--poll-ms` | 預設 `2000`；正整數、上限 `2147483647` |

`bind --config` 指定寫入位置，預設 `runtime/config.json`。`request` 與 `serve` 讀取 `--config`，只會用 `--target-host-id`、`--auto-reply`、`--result-timeout-ms`、`--poll-ms` 覆蓋對應欄位；不是任意 bind 選項都可在讀設定時覆蓋。其餘接線需重新 bind 或編輯本機 JSON。`codexPipePath` 缺省時仍可從環境補入。

`serve`、`status`、`send` 的 `--state` 預設為 `runtime/state.json`。`request` 與 `send` 使用 `--message-file`；`send --registry-dir` 可覆蓋 state 中的 registry 位置。MCP 專用的 `timeoutMs` 不會調整 bridge CLI 的 Codex RPC，該 CLI 使用 adapter 預設 30 秒。

### 直接 Claude CLI

```powershell
node src/cli.mjs claude sessions
node src/cli.mjs claude send --session-id "YOUR_LIVE_CLAUDE_SESSION_UUID" --callback-uri "YOUR_RUNNING_CALLBACK_URI" --message-file "runtime/request.txt"
```

`sessions` 只接受可選的 `--registry-dir`。`send` 接受 `--session-id`、`--registry-dir`、`--message-file`、`--callback-uri`；它不啟動 receiver，callback 必須是你已啟動且有效的本機 `uds:` URI。不能用任意文字代替、猜測其他程序地址，或期待命令退出後仍能接回覆。需要由工具管理 callback 時使用 MCP 或 `bridge serve`。

## 排錯與未知結果

| 現象 | 檢查方式 |
|---|---|
| MCP 啟動失敗 | 核對 Node 路徑、絕對入口、owner、當次 pipe 及八個有效啟動選項；本工具不安裝客戶端設定 |
| `PIPE_ERROR`／`PIPE_CLOSED` | Codex App 是否仍執行、是否重啟、pipe 是否仍為當次值；重新做唯讀確認 |
| Claude `not_available` | 目的是否仍 live、是否只有一筆精確 session；歷史存在不代表可發送 |
| `AUTH_KEY_UNAVAILABLE` | 原生 Claude 程序／registry 是否有效且可讀；不要公開 key，也不要為測試改帳戶權限 |
| inbox `pending` | 目的是否用原生 SendMessage 回 `from`；是否還在同一 MCP 程序；查 `nextOffset`／`retainedFrom` |
| `TARGET_BUSY_TIMEOUT` | 未派送，目的尚未空閒；先看目的正在做什麼 |
| `RESULT_TIMEOUT`／`COMPLETED_WITHOUT_FINAL` | 已派送但未取得可確認的本次完整 final；用目的 ID 與 `msgId`／`turnId` 核對聊天 |
| 客戶端取消或更早逾時 | 一併核對客戶端工具時間與 server 結果時間；取消等候不等於取消已送出的對端工作 |

遇到 `unknown`，先讀取目的聊天或 Claude 收件箱，判斷原工作是否已收到／完成。**逾時、斷線、格式錯誤與不完整回覆均不會自動重送。**在查明前再次傳送可能讓對端執行兩次。
