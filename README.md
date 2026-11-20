# C(Codex)-C(Claude) Chat Bridge

English · [繁體中文](docs/README.zh-TW.md)

Let **Codex, Claude Code, and Antigravity CLI (`agy`) exchange messages and read chats** without you copying messages between them.

Ask Claude to get help from Codex, or have one model send work to an Antigravity CLI chat and collect its reply. The bridge uses each client's native chat interface.

## What you can do

- Send messages and receive replies across the supported chat clients.
- Find and read chats to give a model the context it needs.
- Reach Codex chats on other computers already connected to Codex Desktop, such as a Mac.

## Get connected

1. Download or clone this project.
2. Open the project in the client you want to connect. Give its model the [setup prompt](docs/setup-prompt.md).
3. The model configures its client and checks that it can read the chat sources you want to use.

You need **Windows, Node.js 20 or later, and a running Codex Desktop** for the shared bridge. To use Claude Code or Antigravity CLI, set up the corresponding client in the [setup guide](docs/usage.md#接入-mcp).

Once connected, tell your model which chat to contact and what to send. A message being sent does not always mean a reply has arrived; if the outcome is unclear, check the destination chat before trying again.

## Things to know

- Claude support currently covers local Claude Code chats. The Claude App and Claude on other devices are not connected.
- Saved Claude chats can be read, but messaging requires a running Claude Code session. Keep the connection open while waiting for its reply.
- Antigravity chat access follows the sessions available through [Antigravity CLI's ACP interface](docs/interfaces.md#antigravity-cli-工具).
- Updates or restarting Codex Desktop may require reconnecting.
- Connect only clients you trust: they can read visible chat text and tool results.

## More information

[Setup and troubleshooting](docs/usage.md) · [Technical reference](docs/interfaces.md) · [Contributing](.github/CONTRIBUTING.md) · [Security](.github/SECURITY.md)

Detailed guides are currently in Traditional Chinese.

[MIT License](LICENSE). An independent project, not affiliated with OpenAI, Anthropic, or Google.
