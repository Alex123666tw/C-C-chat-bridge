# C(Codex)-C(Claude) Chat Bridge

[English](../README.md) · 繁體中文

讓 **Codex 與 Claude Code 互相傳訊息、讀取對方聊天並協調工作**，省去人工轉貼。

你可以讓 Claude 請 Codex 幫忙，也可以讓 Codex 把工作傳給正在執行的 Claude Code 聊天並取得回覆。橋接會接上雙方既有的聊天介面。

## 能做什麼

- 在 Codex 與 Claude Code 之間傳訊息、接收回覆。
- 找到並讀取聊天，讓雙方取得工作所需的上下文。
- 聯繫 Codex Desktop 已連線的其他電腦上的 Codex 聊天，例如 Mac。

## 開始使用

1. 下載或 clone 本專案。
2. 在 Codex 與 Claude Code 開啟本專案，把[配置提示](setup-prompt.md#繁體中文)分別交給兩邊的模型。
3. 各模型會配置自己的連線，並確認雙方聊天都能讀取。若需要重載客戶端，模型會告訴你具體操作。

需要 **Windows、Node.js 20 以上、Codex Desktop，以及正在執行的 Claude Code 聊天**。想手動配置，可看[安裝說明](usage.md)。

接好後，告訴模型要聯繫哪個聊天、傳送什麼內容。訊息送出不一定代表已收到回覆；結果不明時，先查看目的聊天再決定是否重送。

## 使用前須知道

- Claude 目前支援本機 Claude Code 聊天；Claude App 與其他裝置的 Claude 尚未連線。
- 本工具使用內部聊天介面，版本更新或重啟 Codex Desktop 後可能需要重新接線。
- 只接給受信任的客戶端：它們可以讀取可見聊天正文與工具結果。

## 深入了解

[安裝與排錯](usage.md) · [技術介面](interfaces.md) · [貢獻方式](../.github/CONTRIBUTING.md) · [安全政策](../.github/SECURITY.md)

採用 [MIT License](../LICENSE)。本專案為獨立工具，與 OpenAI、Anthropic 無官方關聯。
