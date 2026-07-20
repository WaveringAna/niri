# @mira/harness-protocol

Dependency-free contracts and runtime parsers for direct tool-host calls and results. Exported parser names retain their original `Client` wording for API compatibility.

Supported capabilities are `shell`, `read_file`, `edit_file`, and `image_tool`. Validate incoming JSON with `parseToolInvocation` or `parseClientToolResult` before using it.
