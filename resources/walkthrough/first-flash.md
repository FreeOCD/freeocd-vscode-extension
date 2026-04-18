# Flash your firmware

You are ready to write your first firmware image!

1. Run `FreeOCD: Flash`.
2. A notification shows progress with a **Cancel** button. Cancellation is
   honoured at word boundaries.
3. If **Verify after flash** is enabled (default), FreeOCD reads the flash
   back and reports any mismatches.

## What next?

- Open the **FreeOCD: Open RTT Terminal** command for bidirectional SEGGER RTT.
- Add a `freeocd` task to `tasks.json` to chain flash after your build:

```json
{
  "label": "Build & flash",
  "dependsOrder": "sequence",
  "dependsOn": ["Build", "Flash firmware"]
}
```

- From any MCP-enabled chat, run `/mcp.freeocd.debug_flash_error` to have
  the AI triangulate a failed flash.
