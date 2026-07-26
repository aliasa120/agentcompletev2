import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import fs from "fs";
import path from "path";

const MEMORY_BASE_DIR = path.join(process.cwd(), "..", "data", "memories");

function getScopedMemoryDir(userId: string, workflowId: string): string {
  const cleanUser = userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const cleanWorkflow = workflowId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const dir = path.join(MEMORY_BASE_DIR, cleanUser, cleanWorkflow);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    const activeUserId = user ? user.id : "default_user";

    const { searchParams } = request.nextUrl;
    const workflowId = searchParams.get("workflow_id") || "default_workflow";
    const fileType = searchParams.get("file") || "MEMORY.md"; // 'USER.md' or 'MEMORY.md'

    const dir = getScopedMemoryDir(activeUserId, workflowId);
    const fileName = fileType.toUpperCase().endsWith("USER.MD") ? "USER.md" : "MEMORY.md";
    const filePath = path.join(dir, fileName);

    let content = "";
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, "utf-8");
    } else {
      if (fileName === "USER.md") {
        content = `# User Profile (${activeUserId})\nWorkflow: ${workflowId}\n\n## Preferences\n- None recorded yet.\n\n## Standing Instructions\n- None recorded yet.\n`;
      } else {
        content = `# Persistent Memories (${workflowId})\nUser: ${activeUserId}\n\n## General Facts\n- Initialized local memory file.\n`;
      }
      fs.writeFileSync(filePath, content, "utf-8");
    }

    // Query user's agent_settings for Honcho credentials & memory budget limits
    let honchoApiKey = process.env.HONCHO_API_KEY || "";
    let honchoApiUrl = process.env.HONCHO_API_URL || "";
    let honchoWorkspace = process.env.HONCHO_WORKSPACE || "";
    let userCharLimit = 1375;
    let memoryCharLimit = 2200;

    if (user) {
      try {
        const { data: rows } = await supabase
          .from("agent_settings")
          .select("key, value")
          .eq("user_id", user.id)
          .in("key", ["honcho_api_key", "honcho_api_url", "honcho_workspace", "memory_user_char_limit", "memory_file_char_limit"]);

        if (rows) {
          for (const row of rows) {
            if (row.key === "honcho_api_key" && row.value) honchoApiKey = row.value.trim();
            if (row.key === "honcho_api_url" && row.value) honchoApiUrl = row.value.trim();
            if (row.key === "honcho_workspace" && row.value) honchoWorkspace = row.value.trim();
            if (row.key === "memory_user_char_limit" && row.value) userCharLimit = parseInt(row.value, 10) || 1375;
            if (row.key === "memory_file_char_limit" && row.value) memoryCharLimit = parseInt(row.value, 10) || 2200;
          }
        }
      } catch (err) {
        console.error("Failed to query user's Honcho settings from agent_settings:", err);
      }
    }

    const isHonchoConfigured = Boolean(honchoApiKey);

    return NextResponse.json({
      user_id: activeUserId,
      workflow_id: workflowId,
      file: fileName,
      content,
      budget_limits: {
        user_char_limit: userCharLimit,
        memory_char_limit: memoryCharLimit,
      },
      honcho_status: {
        configured: isHonchoConfigured,
        api_url: honchoApiUrl || (isHonchoConfigured ? "https://api.honcho.dev" : "Not configured (optional cloud memory provider)"),
        workspace: honchoWorkspace || "default_workspace",
      }
    });

  } catch (error: any) {
    console.error("Error fetching memories:", error);
    return NextResponse.json({ error: error.message || "Failed to load memory file" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    const activeUserId = user ? user.id : "default_user";

    const body = await request.json();
    const workflowId = body.workflow_id || "default_workflow";
    const fileType = body.file || "MEMORY.md";
    const content = body.content;

    // Handle budget settings save if passed
    if (user && (body.memory_user_char_limit !== undefined || body.memory_file_char_limit !== undefined)) {
      const updates = [];
      if (body.memory_user_char_limit !== undefined) {
        updates.push({ user_id: user.id, key: "memory_user_char_limit", value: String(body.memory_user_char_limit) });
      }
      if (body.memory_file_char_limit !== undefined) {
        updates.push({ user_id: user.id, key: "memory_file_char_limit", value: String(body.memory_file_char_limit) });
      }
      if (updates.length > 0) {
        await supabase.from("agent_settings").upsert(updates, { onConflict: "user_id,key" });
      }
    }

    if (content !== undefined) {
      const dir = getScopedMemoryDir(activeUserId, workflowId);
      const fileName = fileType.toUpperCase().endsWith("USER.MD") ? "USER.md" : "MEMORY.md";
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, content, "utf-8");
    }

    return NextResponse.json({
      success: true,
      message: `Successfully updated memory settings for workflow ${workflowId}.`,
      user_id: activeUserId,
      workflow_id: workflowId,
      file: fileType,
    });

  } catch (error: any) {
    console.error("Error saving memory file:", error);
    return NextResponse.json({ error: error.message || "Failed to save memory file" }, { status: 500 });
  }
}
