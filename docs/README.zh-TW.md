# C(Codex)-C(Claude) Chat Bridge

[English](../README.md) · 繁體中文

讓 **Codex、Claude Code 與 Antigravity CLI（`agy`）互相傳訊息並讀取聊天**，省去人工轉貼。

你可以讓 Claude 請 Codex 幫忙，也可以讓模型把工作傳給 Antigravity CLI 聊天並取得回覆。橋接使用各工具的原生聊天介面。

## 能做什麼

- 在支援的聊天客戶端之間傳訊息、接收回覆。
- 找到並讀取聊天，給模型工作所需的上下文。
- 聯繫 Codex Desktop 已連線的其他電腦上的 Codex 聊天，例如 Mac。

## 開始使用

1. 下載或 clone 本專案。
2. 在想接入的客戶端開啟本專案，把[配置提示](setup-prompt.md#繁體中文)交給模型。
3. 模型會配置自己的客戶端，並確認能讀取你想使用的聊天來源。

共用橋接需要 **Windows、Node.js 20 以上與正在執行的 Codex Desktop**。Claude Code 與 Antigravity CLI 可依[安裝說明](usage.md#接入-mcp)設定。

接好後，告訴模型要聯繫哪個聊天、傳送什麼內容。訊息送出不一定代表已收到回覆；結果不明時，先查看目的聊天再決定是否重送。

## 使用前須知道

- Claude 目前支援本機 Claude Code 聊天；Claude App 與其他裝置的 Claude 尚未連線。
- 已儲存的 Claude 聊天可讀取；傳訊需要 Claude Code 工作階段仍在執行，等待回覆時也須保持連線。
- Antigravity 聊天的可見範圍依 [Antigravity CLI 的 ACP 介面](interfaces.md#antigravity-cli-工具)而定。
- 版本更新或重啟 Codex Desktop 後可能需要重新接線。
- 只接給受信任的客戶端：它們可以讀取可見聊天正文與工具結果。

## 深入了解

[安裝與排錯](usage.md) · [技術介面](interfaces.md) · [貢獻方式](../.github/CONTRIBUTING.md) · [安全政策](../.github/SECURITY.md)

採用 [MIT License](../LICENSE)。本專案為獨立工具，與 OpenAI、Anthropic 或 Google 無官方關聯。
