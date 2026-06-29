import { NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";

export async function GET() {
  try {
    const scriptPath = path.resolve(process.cwd(), "..", "get_tool_schemas.py");
    const cmd = `uv run python "${scriptPath}"`;
    const output = execSync(cmd, { 
      cwd: path.resolve(process.cwd(), ".."),
      encoding: "utf-8" 
    });
    const data = JSON.parse(output);
    return NextResponse.json(data);
  } catch (e: any) {
    console.error("Error listing tools in API:", e);
    return NextResponse.json({ error: e.message || "Failed to list tools" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { tool_names } = await req.json();
    if (!Array.isArray(tool_names) || tool_names.length === 0) {
      return NextResponse.json({ error: "tool_names array is required" }, { status: 400 });
    }

    const scriptPath = path.resolve(process.cwd(), "..", "get_tool_schemas.py");
    // Quote each tool name to protect against shell injection
    const args = tool_names.map(name => {
      // Allow alphanumeric, underscores, dashes, dots, slashes, and colons
      const sanitized = name.replace(/[^a-zA-Z0-9_\-\.\/:]/g, "");
      return `"${sanitized}"`;
    }).join(" ");
    
    const cmd = `uv run python "${scriptPath}" ${args}`;
    const output = execSync(cmd, { 
      cwd: path.resolve(process.cwd(), ".."),
      encoding: "utf-8" 
    });
    const schemas = JSON.parse(output);
    return NextResponse.json({ schemas });
  } catch (e: any) {
    console.error("Error getting tool schemas in API:", e);
    return NextResponse.json({ error: e.message || "Failed to load schemas" }, { status: 500 });
  }
}

