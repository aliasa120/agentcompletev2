import { NextResponse } from "next/server";
import { testStdioMcp, testSseMcp, testHttpMcp } from "@/lib/mcp-tester";

export async function POST(req: Request) {
  try {
    const { transport, mcp_url, command, args, env, headers } = await req.json();

    if (!transport) {
      return NextResponse.json({ error: "transport parameter required" }, { status: 400 });
    }

    let parsedHeaders: Record<string, string> = {};
    if (headers) {
      if (typeof headers === "object") {
        parsedHeaders = headers;
      } else if (typeof headers === "string" && headers.trim().length > 0) {
        try {
          parsedHeaders = JSON.parse(headers);
        } catch (je: any) {
          return NextResponse.json({ error: `Invalid custom headers JSON: ${je.message}` }, { status: 400 });
        }
      }
    }

    if (transport === "stdio") {
      if (!command) {
        return NextResponse.json({ error: "command required for stdio process transport" }, { status: 400 });
      }

      // Parse arguments
      let parsedArgs: string[] = [];
      if (Array.isArray(args)) {
        parsedArgs = args;
      } else if (typeof args === "string" && args.trim().length > 0) {
        parsedArgs = args.split(/\s+/).map(a => a.trim()).filter(a => a.length > 0);
      }

      // Parse environment variables
      let parsedEnv: Record<string, string> = {};
      if (env) {
        if (typeof env === "object") {
          parsedEnv = env;
        } else if (typeof env === "string") {
          env.split("\n").forEach(line => {
            const idx = line.indexOf("=");
            if (idx !== -1) {
              const k = line.slice(0, idx).trim();
              const v = line.slice(idx + 1).trim();
              if (k) parsedEnv[k] = v;
            }
          });
        }
      }

      try {
        const result = await testStdioMcp(command, parsedArgs, parsedEnv);
        return NextResponse.json({ success: true, tools: result.tools, logs: result.logs });
      } catch (err: any) {
        // Pass through any logs captured before the timeout/error
        const errLogs = err.logs || [];
        return NextResponse.json({ success: false, error: err.message || "Stdio process test failed", logs: errLogs }, { status: 500 });
      }
    } 

    if (!mcp_url) {
      return NextResponse.json({ error: "mcp_url required for network transport" }, { status: 400 });
    }

    if (transport === "sse") {
      try {
        const result = await testSseMcp(mcp_url, parsedHeaders);
        return NextResponse.json({ success: true, tools: result.tools, logs: result.logs });
      } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message || "SSE connection failed" }, { status: 500 });
      }
    }

    if (transport === "http") {
      try {
        const result = await testHttpMcp(mcp_url, parsedHeaders);
        return NextResponse.json({ success: true, tools: result.tools, logs: result.logs });
      } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message || "Direct HTTP POST request failed" }, { status: 500 });
      }
    }

    return NextResponse.json({ error: `Unsupported transport: ${transport}` }, { status: 400 });

  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Internal server error" }, { status: 500 });
  }
}
