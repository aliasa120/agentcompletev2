import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/**
 * POST /api/mcp/smithery/install
 * 
 * Downloads an MCP server via the Smithery CLI onto THIS server (shared for all users).
 * The install is recorded in the `smithery_server_installs` table.
 * Individual users then connect to the installed package by adding their own credentials.
 * 
 * Body: { qualifiedName: string, displayName: string }
 * 
 * Returns:
 *   { success: true, config: { command, args, env } }           — installed
 *   { success: false, error: string, isPrivate?: boolean }      — failed
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { qualifiedName, displayName } = body;
  if (!qualifiedName) {
    return NextResponse.json({ success: false, error: "qualifiedName is required" }, { status: 400 });
  }

  // Check if already installed — return cached config
  try {
    const { data: existing } = await supabase
      .from("smithery_server_installs")
      .select("*")
      .eq("qualified_name", qualifiedName)
      .eq("status", "installed")
      .single();

    if (existing) {
      const schema = await getEnhancedConfigSchema(qualifiedName);
      return NextResponse.json({
        success: true,
        alreadyInstalled: true,
        config: existing.install_config,
        installedAt: existing.installed_at,
        schema,
      });
    }
  } catch (e) {
    // Table might not exist yet — continue to install
  }

  // Mark as "installing" in DB first
  try {
    await supabase.from("smithery_server_installs").upsert({
      qualified_name: qualifiedName,
      display_name: displayName ?? qualifiedName,
      status: "installing",
      install_config: null,
      installed_at: null,
    }, { onConflict: "qualified_name" });
  } catch (e) {
    // Non-fatal — proceed with install
    console.warn("[Smithery Install] Failed to mark as installing:", e);
  }

  // Ensure telemetry consent settings.json exists locally to prevent interactive CLI prompt
  let configDir = "";
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    configDir = path.join(process.cwd(), "smithery_config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        userId: "agent-smithery-user",
        analyticsConsent: false,
        askedConsent: true
      }, null, 2),
      "utf-8"
    );
  } catch (e) {
    console.warn("[Smithery Install] Failed to setup telemetry bypass:", e);
  }

  // Use the modern, non-deprecated 'mcp add' command and skip any prompt with --config "{}"
  const command = `npx -y @smithery/cli@latest mcp add "${qualifiedName}" --client claude --config "{}" 2>&1`;

  let stdout = "";
  let stderr = "";

  try {
    const result = await execAsync(command, {
      timeout: 120_000, // 2 minute timeout
      env: {
        ...process.env,
        CI: "true",
        npm_config_yes: "true",
        SMITHERY_CONFIG_PATH: configDir || undefined,
      },
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (err: any) {
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message ?? String(err);

    // If stdout has success:true (e.g. libuv Windows assertion exit code 1), it succeeded!
    const succeededMatch = stdout.includes('"success":true') || stdout.includes('"success": true');
    if (!succeededMatch) {
      // Classify the error
      const combinedOutput = `${stdout}\n${stderr}`.toLowerCase();
      const isPrivate =
        combinedOutput.includes("private") ||
        combinedOutput.includes("not found") ||
        combinedOutput.includes("access denied") ||
        combinedOutput.includes("forbidden") ||
        combinedOutput.includes("unauthorized") ||
        combinedOutput.includes("404");

      const requiresLogin =
        combinedOutput.includes("login") ||
        combinedOutput.includes("sign in") ||
        combinedOutput.includes("authentication required") ||
        combinedOutput.includes("credentials");

      // Update DB status to failed
      try {
        await supabase.from("smithery_server_installs").upsert({
          qualified_name: qualifiedName,
          display_name: displayName ?? qualifiedName,
          status: "failed",
          install_config: null,
          error_message: stderr.slice(0, 1000),
          installed_at: null,
        }, { onConflict: "qualified_name" });
      } catch (_) {}

      if (isPrivate) {
        return NextResponse.json({
          success: false,
          isPrivate: true,
          error: "This MCP server is private and cannot be downloaded. Use the Remote connection option instead, which connects directly via Smithery's managed hosting.",
          rawError: stderr.slice(0, 500),
        });
      }

      if (requiresLogin) {
        return NextResponse.json({
          success: false,
          requiresLogin: true,
          error: "This MCP server requires Smithery account login to install. Use the Remote connection option instead.",
          rawError: stderr.slice(0, 500),
        });
      }

      return NextResponse.json({
        success: false,
        error: `Installation failed: ${stderr.slice(0, 400) || "Unknown error"}`,
        rawError: stderr.slice(0, 500),
      });
    }
  }

  // Parse the installed config from the Claude Desktop config file
  // The Smithery CLI writes to ~/.config/Claude/claude_desktop_config.json
  // We need to extract the config for this specific server
  let installConfig: { command: string; args: string[]; env: Record<string, string> } | null = null;

  try {
    installConfig = await extractInstalledConfig(qualifiedName, stdout);
  } catch (e) {
    console.warn("[Smithery Install] Could not parse install config:", e);
  }

  // If we couldn't parse from file, build a fallback from qualifiedName
  if (!installConfig) {
    // Most Smithery MCPs install as: npx @smithery/sdk@latest run <qualifiedName>
    installConfig = {
      command: "npx",
      args: ["-y", "@smithery/sdk", "run", qualifiedName],
      env: {},
    };
  }

  // Save successful install to DB
  try {
    await supabase.from("smithery_server_installs").upsert({
      qualified_name: qualifiedName,
      display_name: displayName ?? qualifiedName,
      status: "installed",
      install_config: installConfig,
      error_message: null,
      installed_at: new Date().toISOString(),
    }, { onConflict: "qualified_name" });
  } catch (e) {
    console.error("[Smithery Install] Failed to save install record:", e);
    // Not fatal — return success anyway
  }

  // Install the package locally in node_modules to enable direct 'node' execution (bypassing WScript/npx cache permission issues)
  try {
    const { resolveNpmPackage } = await import("../../manual/route");
    const npmPackageName = await resolveNpmPackage(qualifiedName);
    
    // Validate if the resolved package is a match or a false positive (meaning the server has no local NPM package)
    const parts = qualifiedName.split("/");
    const shortName = parts[parts.length - 1].toLowerCase();
    const cleanPkgName = npmPackageName.replace(/^@/, "").split("/").pop() || "";
    
    if (!cleanPkgName.toLowerCase().includes(shortName)) {
      throw new Error(`This server is remote-only and does not have a local NPM package. Please click "Remote" to connect instead.`);
    }

    console.log(`[Smithery Install] Running local npm install for ${npmPackageName}...`);
    await execAsync(`npm install --no-save --legacy-peer-deps ${npmPackageName}`, {
      timeout: 60000,
      env: process.env,
    });
  } catch (err: any) {
    console.warn("[Smithery Install] Failed to install package locally:", err);
    if (err.message && err.message.includes("remote-only")) {
      return NextResponse.json({
        success: false,
        error: err.message
      });
    }
  }

  // Fetch the configuration schema from Smithery's API to extract required environment variables
  const schema = await getEnhancedConfigSchema(qualifiedName);

  return NextResponse.json({
    success: true,
    alreadyInstalled: false,
    config: installConfig,
    stdout: stdout.slice(0, 1000),
    schema,
  });
}

/**
 * Discover environment variables from the NPM package README file
 */
async function discoverEnvFromReadme(packageName: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const readme = (data.readme || "") as string;
      const regex = /[A-Z0-9_]{3,30}_(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|URL|PATH|ID|USER|USERNAME|PORT)/g;
      const matches = [...new Set(readme.match(regex) || [])] as string[];
      if (matches.length > 0) {
        const properties: Record<string, any> = {};
        const excludes = [
          "PATH", "HOME", "TEMP", "TMP", "CI", "SYSTEMROOT", "WINDIR", "USER", "PORT",
          "YOUR_API_KEY", "YOUR_KEY", "YOUR_API_KEY_HERE", "YOUR_CLIENT_ID", "YOUR_CLIENT_SECRET",
          "API_KEY", "APP_KEY", "SECRET_KEY", "PRIVATE_KEY"
        ];
        for (const match of matches) {
          if (excludes.includes(match)) continue;
          
          properties[match] = {
            type: "string",
            description: `Required environment variable: ${match}`
          };
        }
        if (Object.keys(properties).length > 0) {
          return { properties };
        }
      }
    }
  } catch (e) {
    console.warn("[Smithery Install] Failed to discover env from readme:", e);
  }
  return null;
}

/**
 * Fetch detailed server info from Smithery API and fall back to NPM README env extraction if empty
 */
async function getEnhancedConfigSchema(qualifiedName: string) {
  let schema: any = null;
  try {
    const res = await fetch(`https://api.smithery.ai/servers/${qualifiedName}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const connections = data.connections ?? [];
      const httpConn = connections.find((c: any) => c.configSchema);
      if (httpConn && httpConn.configSchema) {
        schema = httpConn.configSchema;
      }
    }
  } catch (e) {
    console.warn("[Smithery Install] Failed to fetch config schema from Smithery API:", e);
  }

  // Fallback to NPM README parsing if schema is empty/null/missing properties
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    try {
      const { resolveNpmPackage } = await import("../../manual/route");
      const npmPackageName = await resolveNpmPackage(qualifiedName);
      const discovered = await discoverEnvFromReadme(npmPackageName);
      if (discovered) {
        schema = discovered;
      }
    } catch (e) {
      console.warn("[Smithery Install] Failed to resolve and discover env:", e);
    }
  }

  return schema;
}

/**
 * Try to read the installed config from the Claude Desktop config file.
 * The Smithery CLI writes the server config there.
 */
async function extractInstalledConfig(
  qualifiedName: string,
  installOutput: string
): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> {
  const fs = await import("fs/promises");
  const os = await import("os");
  const path = await import("path");

  const homeDir = os.homedir();
  const configPaths = [
    path.join(homeDir, ".config", "Claude", "claude_desktop_config.json"),
    path.join(homeDir, "AppData", "Roaming", "Claude", "claude_desktop_config.json"), // Windows
    path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"), // macOS
  ];

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      const mcpServers = config.mcpServers ?? {};

      // The key is usually the short name or qualifiedName
      for (const [key, serverConfig] of Object.entries(mcpServers as Record<string, any>)) {
        if (
          qualifiedName.includes(key) ||
          key.includes(qualifiedName.split("/").pop() ?? "")
        ) {
          return {
            command: serverConfig.command ?? "npx",
            args: serverConfig.args ?? [],
            env: serverConfig.env ?? {},
          };
        }
      }
    } catch {
      // File doesn't exist or can't be read — try next path
    }
  }

  return null;
}

/**
 * GET /api/mcp/smithery/install
 * Returns list of all installed Smithery packages on this server
 */
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("smithery_server_installs")
      .select("*")
      .order("installed_at", { ascending: false });

    if (error) {
      return NextResponse.json({ installs: [], error: error.message });
    }

    return NextResponse.json({ installs: data ?? [] });
  } catch (e) {
    return NextResponse.json({ installs: [], error: String(e) });
  }
}
