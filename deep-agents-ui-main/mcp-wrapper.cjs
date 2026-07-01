const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// The script to run is the first argument passed to this wrapper
const targetScript = process.argv[2];
const targetArgs = process.argv.slice(3);

if (!targetScript) {
  console.error("Usage: node mcp-wrapper.cjs <path-to-mcp-server.js> [args...]");
  process.exit(1);
}

// Resolve the absolute path of the target script
let absoluteScriptPath = path.resolve(process.cwd(), targetScript);
let runCwd = process.cwd();

if (!fs.existsSync(absoluteScriptPath) && !path.isAbsolute(targetScript)) {
  const altPath = path.resolve(process.cwd(), "deep-agents-ui-main", targetScript);
  if (fs.existsSync(altPath)) {
    absoluteScriptPath = altPath;
    runCwd = path.resolve(process.cwd(), "deep-agents-ui-main");
  }
}

// Spawn Node to run the target script
const child = spawn("node", [absoluteScriptPath, ...targetArgs], {
  stdio: ["pipe", "pipe", "inherit"], // inherit stderr directly so logs appear in console
  env: process.env,
  cwd: runCwd,
});

let stdoutBuffer = "";

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split(/\r?\n/);
  // Keep the last partial line in the buffer
  stdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if the line is valid JSON (starting with '{' and ending with '}')
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      process.stdout.write(line + "\n");
    } else {
      // It's a plain text banner or debug log, redirect to stderr so it doesn't corrupt the protocol
      process.stderr.write(`[MCP-Wrapper Filtered STDOUT] ${line}\n`);
    }
  }
});

// Handle stdin forwarding from client to server
process.stdin.on("data", (chunk) => {
  if (child.stdin.writable) {
    child.stdin.write(chunk);
  }
});

child.on("close", (code) => {
  process.exit(code || 0);
});

child.on("error", (err) => {
  console.error(`[MCP-Wrapper Error] Failed to start child process: ${err.message}`);
  process.exit(1);
});
