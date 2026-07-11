# Niri

Niri runs each AI agent in a server worker and attaches that agent to a separate local tool client. Model calls, durable state, memory, and Discord stay on the server. Shell, file reads, exact edits, and image reads happen only on the paired client workspace.

## Local quick start

Requirements: Node.js 20.19+ (or 22.12+), npm 10+, and Bash. `@mira/harness-client-node` uses `node-pty`, so a platform without a prebuild also needs the normal native Node build toolchain.

```sh
npm install
cp .env.example .env
```

Set a model provider in `.env`. Generate two different secrets with `openssl rand -hex 32`, then put them in these `.env` fields:

```dotenv
NIRI_CONTROL_TOKEN=replace-with-management-secret
NIRI_TOOL_CLIENT_TOKEN=replace-with-agent-pairing-secret
```

Start the server:

```sh
npm start
```

In another terminal, pair the workspace that should own local tools:

```sh
export NIRI_SERVER_URL='http://127.0.0.1:3000'
export NIRI_AGENT_ID='niri'
export NIRI_CLIENT_ID='niri-local'
export NIRI_TOOL_CLIENT_TOKEN='replace-with-agent-pairing-secret'
export NIRI_CLIENT_WORKSPACE="$HOME/Developer/project"
npm run start:client
```

Open `http://127.0.0.1:3000/ui#token=<NIRI_CONTROL_TOKEN>` once; the UI moves the fragment into tab-scoped storage and removes it from the address bar. Full multi-agent, remote-access, security, package-reuse, and recovery instructions are in [docs/client-server.md](./docs/client-server.md).

## Verification

```sh
npm run typecheck
npm test
npm run build
```
