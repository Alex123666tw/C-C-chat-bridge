# C(Codex)-C(Claude) Chat Bridge

English · [繁體中文](docs/README.zh-TW.md)

Let **Codex and Claude Code exchange messages, read each other's chats, and coordinate work** without you copying messages between them.

Ask Claude to get help from Codex, or have Codex send a task to a running Claude Code chat and receive its reply. The bridge connects their existing chat interfaces.

## What you can do

- Send messages and receive replies between Codex and Claude Code.
- Find and read chats to give either side the context it needs.
- Reach Codex chats on other computers already connected to Codex Desktop, such as a Mac.

## Get connected

1. Download or clone this project.
2. Open the project in Codex and Claude Code. Give each model the [setup prompt](docs/setup-prompt.md).
3. Each model configures its own connection and checks that it can read both sides. If a client needs reloading, it will tell you what to do.

You need **Windows, Node.js 20 or later, Codex Desktop, and a running Claude Code chat**. For manual setup, see the [setup guide](docs/usage.md).

Once connected, tell your model which chat to contact and what to send. A message being sent does not always mean a reply has arrived; if the outcome is unclear, check the destination chat before trying again.

## Things to know

- Claude support currently covers local Claude Code chats. The Claude App and Claude on other devices are not connected.
- Saved Claude chats can be read, but messaging requires a running Claude Code session. Keep the connection open while waiting for its reply.
- The bridge uses internal app interfaces, so updates or restarting Codex Desktop may require reconnecting.
- Connect only clients you trust: they can read visible chat text and tool results.

## More information

[Setup and troubleshooting](docs/usage.md) · [Technical reference](docs/interfaces.md) · [Contributing](.github/CONTRIBUTING.md) · [Security](.github/SECURITY.md)

Detailed guides are currently in Traditional Chinese.

[MIT License](LICENSE). An independent project, not affiliated with OpenAI or Anthropic.
