# 介面與限制

[回到首頁](../README.md) · [安裝與使用](usage.md) · [安全政策](../.github/SECURITY.md)

本工具是原生聊天介面的薄橋接。Codex 端直接呼叫 Desktop 的內部跨聊天工具；Claude 端讀取本機可見歷史並使用認證訊息管道。它不提供一般檔案服務，也不新增對外 HTTP server。

Codex 的聊天清單以當次原生 `list_threads` 為準，可能包括本機、已連線遠端及 ChatGPT 聊天；讀取仍是原生可取得的回合與摘要。Claude 的原生 `ListAgents` 列出可聯繫的 peer，不等於全部儲存歷史；本橋接的 `claude_list_chats` 另外列出本機歷史，只有 `live`／`sendAvailable` 的聊天可嘗試傳訊。Claude 原生 `SendMessage` 用來傳訊，沒有讀取對方歷史的參數。

MCP 只是把聊天操作提供給模型的工具入口。底層傳訊使用原生介面，CLI 也可直接使用；不必另開網路服務。模型應先列出聊天取得目的 ID，再讀取或傳訊；等 Claude 回覆時須保持接收連線。關掉聊天畫面、停止工作階段、關掉回程接收器是不同狀態，不能只用「尚未封存」判斷是否可傳訊。本橋接不會自行恢復已停止的 Claude 主聊天。

## 工具介面

MCP 入口為 `src/mcp-server.mjs`，以 stdin/stdout 每行一個 JSON-RPC 2.0 訊息通訊。客戶端需先 `initialize`、送 `notifications/initialized`，再使用 `tools/list`／`tools/call`。支援 `ping` 與 `notifications/cancelled`；工具列表沒有分頁。結果同時提供文字 JSON 與 `structuredContent`；`failed`／`unknown` 可帶 `isError: true`。

### Codex 原生工具

以下五個工具的 descriptions、`inputSchema` 與成功回傳沿用**當次 Codex 原生 catalog**。請由 `tools/list` 查看目前版本的精確 schema；表中是使用重點，不取代原生欄位定義。

| MCP 工具 | 用途與限制 |
|---|---|
| `codex_list_threads` | 近期聊天與完整 pinned 清單；近期 `limit` 上限 50，沒有近期列表分頁 |
| `codex_list_archived_threads` | 原生封存清單；沿用 `cursor`、`hostId` 等原生分頁／主機欄位 |
| `codex_read_thread` | `threadId`、可選 `hostId`；一次最多 10 回合，以回傳 `cursor` 讀較舊回合；原生摘要與截斷標記保留 |
| `codex_wait_threads` | 原生等待／狀態；使用 targets 的 `threadId`、可選 `hostId`／`afterCursor` 與 `timeoutMs`；不等同本次請求完整答覆 |
| `codex_send_message_to_thread` | 原生傳訊，必須有使用者授權；成功包為 `accepted`、`msgId`、`threadId`、可選 `hostId` 與 `native` |

`codex_read_thread` 的原生 `includeOutputs`、`maxOutputCharsPerItem` 決定能否包含工具輸出及其長度；本工具保留原生 response，不把它重組成完整逐字稿。列表及讀取的 host/cursor 沿用原生值，不轉成本工具的新 host ID。

目前沒有暴露建立聊天、修改聊天、封存聊天或一般檔案工具。可以列／讀已封存聊天，不代表本工具新增了封存操作。若原生 catalog 缺少必要工具，對應能力就不可用。

### `codex_request`

將工作傳給 Codex 並等候其精確新回合 final，僅在原生傳訊與讀取工具可用時提供。

| Argument | 型別與預設 |
|---|---|
| `prompt` | 必填非空字串 |
| `threadId` | 非空字串；省略時用 `codexTargetThreadId`，兩者皆缺時拒收 |
| `hostId` | 非空字串；省略時用 `codexTargetHostId`，再省略則原生預設 |
| `timeoutMs` | 正整數；預設 server `resultTimeoutMs`，其預設為 `600000` |
| `pollMs` | 1–`2147483647` 的整數；預設 server `resultPollMs`，其預設為 `2000` |

不接受額外 arguments。完整成功結果為 `status: "completed"`、`turnId`、`text`、`msgId`、`threadId` 及可選 `hostId`。工具不修改對端帳戶、模型或審查規則。

同一 MCP 程序對相同 host/thread 的派送按序執行；這個序列不跨程序同步，也無法阻止人類或其他客戶端同時傳訊。

### Claude 工具

| MCP 工具 | Arguments | 回傳與使用重點 |
|---|---|---|
| `claude_list_chats` | `offset`、`limit` | `scope`、`chats`、`total`、`offset`、`nextOffset`；主聊天包含 `subagents`、`live`、`sendAvailable` |
| `claude_read_chat` | 必填 `sessionId`；可選 `agentId`、`projectKey`、`offset`、`limit` | `status: "read"`、可見 `messages`、`nextOffset`；同 session 多份歷史須用 `projectKey` 消歧義 |
| `claude_send_message` | 必填 `sessionId`、`message` | 精確 live session；回傳 `msgId`、`callbackUri`、狀態與 `delivery`；不啟動或恢復 Claude 聊天 |
| `claude_read_inbox` | 可選 `sessionId`、`offset`、`limit` | `received`／`pending`、`items`、`nextOffset`、`retainedFrom`、`processLocal: true` |

`sessionId` 為 UUID；`agentId` 為列表取得的 1–128 字元英數字、底線或連字號，僅用於讀已列出的子代理歷史。`projectKey` 為非空字串。`offset` 為非負整數，`limit` 為 1–100，預設分別為 0、20；所有 Claude 工具都拒收未知 arguments。傳訊 `message` 必須是非空字串。

三種 offset 含義不同：聊天列表以清單位置分頁；歷史以**原始 JSONL 記錄的零起算位置**讀取；inbox 以接收器的遞增 index 讀取。歷史會跳過不可見記錄，請使用回傳的 `nextOffset`，不要自行用已顯示訊息數量相加。列表或歷史的 `nextOffset: null` 表示當次沒有下一頁。

Claude 歷史以原生記錄順序回傳，保留 `parentUuid`，不推定分支為單一直線對話。主聊天與子代理分開標示。`not_available` 會說明 `LIVE_SESSION_NOT_FOUND`、`AMBIGUOUS_SESSION`、`HISTORY_NOT_FOUND`、`AMBIGUOUS_HISTORY` 或 `AGENT_HISTORY_NOT_FOUND`；讀不到與不能傳訊是不同結果。

Inbox 中 `receipt` 有 `originalMsgId` 與原生 status；`message` 有來源 `sessionId`、`msgId`、可見 content 與 `correlation: "source_session_only"`。一般回覆沒有可靠的 request ID，不能只因來自同 session 就當成某次工作的完整答覆。

## 完整答覆如何判定

`codex_request`、`bridge request` 與 `bridge serve` 的 `autoReply` 共用結果追蹤方式：

1. 唯讀等待目的 idle，且沒有 `inProgress` 回合；等待與結果共用總時間預算。
2. 保存派送前回合 ID 作為 baseline，加入本次唯一 marker，只派送一次。
3. 讀取新回合，在原生 `codex_app.send_message_to_thread` 的輸出中找到本次 marker，確認它不是 baseline 的舊回合。
4. 追蹤同一 turn ID 至 `completed`。只有 `agentMessage` 的 `final_answer`／`final`、完整字串且未標示 truncated 才能回傳；多段 final 保留順序並合併。

工具不以 summary、對端 idle、派送成功、舊 final 或另一個新回合推定完成。結果 snapshot 需明確且唯一；不符合條件則如實回報 `failed`／`unknown`。目前追蹤讀取最近 3 回合與最多 20000 字元的原生輸出；marker 或完整 final 無法觀察時，不以猜測補上。

### 狀態與送達

| 狀態 | 可據此判斷 |
|---|---|
| `accepted` | Codex 原生工具接受派送，尚未確認工作結果 |
| `submitted_unconfirmed` | 已寫入 Claude 原生認證管道，沒有直接 ACK，等待 callback 證據 |
| `completed` | 精確本次 Codex turn 的完整 final 已觀察到 |
| `received` | 本 MCP 程序 inbox 有符合查詢的訊息／回執 |
| `pending` | 當次查詢没有 inbox 項目 |
| `not_available` | 找不到或無法唯一定位目的／歷史；Claude 傳訊會帶 `delivery: "not_sent"` |
| `failed` | 驗證／準備未通過、未送出，或原生明確拒絕；仍應查看 `delivery`／reason |
| `unknown` | 可能已送出或已接受，但無法確認結果；先查看目的，避免重複執行 |

傳輸會區分 `not_sent`、原生 `failed`、`accepted`、`unknown` 等 delivery。取消 MCP 等待、App 重啟、斷線與逾時不會自動重送；它們也不保證目的工作停止。`bridge serve` 回傳結果給 Claude 的送達狀態，與 Codex 工作的 `outcome: "completed"`／`"unknown"` 分開記錄。

## 信任與資料範圍

- 橋接與客戶端信任同一 Windows 帳號下的程序。Claude token 認證檢查本機 key；持有同帳號檔案存取能力的程序可能取得它。來源 `from` 核對是路由／歸屬檢查，**不是獨立的程序身分驗證**。
- owner 與來源標籤用於原生呼叫範圍及對端辨識。它們**不是人類授權**；本工具不替使用者批准對任意聊天發訊，也不繞過對端審查。
- MCP read 工具不是專案 allowlist。Codex 可見範圍沿用原生 owner，包括 App 已連線的遠端主機；Claude 可列／讀本機 `.claude/projects` 中跨專案的主聊天與子代理歷史。只把此 MCP 接給受信任的客戶端。
- Claude 讀取保留可見 user/assistant 原文、tool inputs/results，排除 hidden thinking、內部事件與獨立 auth key。**正文及工具資料不會自動遮罩秘密**；Codex 原生可見回傳也照原樣保留。
- callback key、私人聊天、pipe 與個人接線設定不得公開。`runtime/`、`tests/output/`、`.work/` 已 gitignore，但 gitignore 不能清除既有 Git 歷史或防止手動複製敏感資料。

本工具沒有新增一般檔案存取介面，不會建立 Claude 聊天、修改帳戶權限或替對端放寬審查。使用仍須遵守各產品條款。

## 跨主機與生命週期

Codex 跨主機透過 Desktop 已建立的連線。從原生列表取得 `hostId`，讀取與傳訊使用同一 host/thread；本工具不另行配對、登入或建立遠端網路服務。Claude 目前只接本機 Claude Code，遠端 Claude 及其他 Claude App 尚未連線。

每個 MCP 客戶端有自己的 server、callback 與 inbox。Receiver 在該程序首次 Claude 傳訊時建立；關閉時清理自己建立的 key。Inbox 上限 1000 件，程序結束即消失。Provider 的 request 對應表與去重 seen 集合目前會在程序存活期間持續累積，沒有持久化或長期修剪；常駐 CLI router 的 seen 集合也有此限制。重新連接會失去這些程序內資料，應先確認尚未完成的工作與回覆。

目前沒有跨程序去重、持久 inbox、自動斷線重連或未知結果的自動補送。原生客戶端版本更新與 Codex App 重啟後，需重新核對接線；短程測試不能證明長時間可靠性。

## 程式嵌入

除 CLI/MCP 可執行入口外，library 使用者可從相對模組 import：

```javascript
import { loadMcpConfig, serveMcp } from './src/mcp-server.mjs';
import { createClaudeChatProvider } from './src/claude-chats.mjs';

const config = await loadMcpConfig(process.argv.slice(2));
const claude = createClaudeChatProvider({
  projectsDir: 'C:/private/claude/projects',
  registryDir: 'C:/private/claude/sessions',
  timeoutMs: 5000,
  fromName: 'My chat bridge',
});
await serveMcp(config, { providers: [claude] });
```

這是專案根目錄 wrapper 的例子；路徑需換成自己實際使用的本機目錄。Factory 預設 `projectsDir`、`registryDir` 分別為使用者 home 下的 `.claude/projects`、`.claude/sessions`，`timeoutMs` 為 5000，`fromName` 為 `Codex chat bridge`。這些是 library factory 參數，**不是 MCP startup flags**；MCP 內建 executable 使用預設 factory。

`serveMcp` 接受可替換的 `input`／`output` 與 `providers`。Provider 契約是 `tools(): Promise<Tool[]>`、`call(name, args): Promise<JSON object>`、可選 `close()`；名稱不可與既有工具重複。EOF 時會停止 Codex 傳輸、等已進入的呼叫結束，再關閉 provider。

CLI 的完整旗標、JSON 欄位與優先序維護於[使用說明](usage.md#mcp-啟動設定)。測試範圍與真模型測試見[貢獻方式](../.github/CONTRIBUTING.md)。
