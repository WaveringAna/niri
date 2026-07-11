# @mira/harness-protocol

Dependency-free wire contracts and runtime parsers for pairing one agent with one remote tool client.

```sh
npm install @mira/harness-protocol
```

The protocol covers authenticated client hello/lease, long polling, tool calls, results, and detach. Import `HARNESS_PROTOCOL_VERSION` when building a hello and run untrusted JSON through the exported `parse*` functions before using it. Supported client capabilities are `shell`, `read_file`, `edit_file`, and `image_tool`.

This package contains no HTTP framework, model provider, filesystem implementation, or Niri-specific tool.
