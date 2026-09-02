import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import fs from "fs";
import path from "path";

// Workspace directories
const WORKSPACE_ROOT = path.resolve(process.cwd(), "..");
const OUTPUT_THREADS_DIR = path.join(WORKSPACE_ROOT, "output", "threads");
const MEMORY_BASE_DIR = path.join(WORKSPACE_ROOT, "data", "memories");

function getLangGraphApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
    process.env.LANGGRAPH_API_URL ||
    "http://localhost:2024"
  ).replace(/\/+$/, "");
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getSupabaseUser(cookieStore: any) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) return null;

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
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
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch (err) {
    console.error("[user-history] Supabase auth check error:", err);
    return null;
  }
}

// GET /api/user-history - Stats about personal history across DB, Checkpointer, and Disk
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const user = await getSupabaseUser(cookieStore);
    const admin = getSupabaseAdmin();

    let userId = user?.id || null;
    let userEmail = user?.email || null;

    // If no user found in cookie (e.g. single-user local dev mode), resolve primary user
    if (!userId && admin) {
      const { data: firstUser } = await admin
        .from("user_settings")
        .select("id")
        .limit(1)
        .maybeSingle();

      if (firstUser?.id) {
        userId = firstUser.id;
      } else {
        // Fallback check in auth.users or default
        const { data: usersData } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
        if (usersData?.users?.[0]) {
          userId = usersData.users[0].id;
          userEmail = usersData.users[0].email || null;
        }
      }
    }

    // 1. Query Supabase Database for Sessions and Messages
    let sessionCount = 0;
    let messageCount = 0;

    if (admin) {
      try {
        if (userId) {
          // Count user's sessions
          const { count: sCount, data: userSessions } = await admin
            .from("sessions")
            .select("id", { count: "exact" })
            .eq("user_id", userId);
          sessionCount = sCount ?? 0;

          if (userSessions && userSessions.length > 0) {
            const sessionIds = userSessions.map((s: any) => s.id);
            const { count: mCount } = await admin
              .from("messages")
              .select("id", { count: "exact", head: true })
              .in("session_id", sessionIds);
            messageCount = mCount ?? 0;
          }
        } else {
          // General count if unsegmented
          const { count: sCount } = await admin
            .from("sessions")
            .select("id", { count: "exact", head: true });
          const { count: mCount } = await admin
            .from("messages")
            .select("id", { count: "exact", head: true });
          sessionCount = sCount ?? 0;
          messageCount = mCount ?? 0;
        }
      } catch (dbErr) {
        console.warn("[user-history] Error querying Supabase sessions/messages:", dbErr);
      }
    }

    // 2. Query LangGraph for threads (with pagination to fetch complete total count)
    const lgBase = getLangGraphApiUrl();
    let threadCount = 0;
    try {
      let offset = 0;
      const pageSize = 100;
      let hasMore = true;

      while (hasMore) {
        const searchPayload: Record<string, any> = {
          limit: pageSize,
          offset,
        };
        if (userId) {
          searchPayload.metadata = { user_id: userId };
        }

        const res = await fetch(`${lgBase}/threads/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(searchPayload),
          cache: "no-store",
        });

        if (res.ok) {
          const batch = await res.json();
          if (Array.isArray(batch) && batch.length > 0) {
            threadCount += batch.length;
            offset += batch.length;
            if (batch.length < pageSize) {
              hasMore = false;
            }
          } else {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }
    } catch (lgErr) {
      console.warn("[user-history] Could not query LangGraph threads:", lgErr);
    }

    // 3. Check disk workspace folders and files
    let diskFolderCount = 0;
    let diskFilesCount = 0;
    try {
      if (fs.existsSync(OUTPUT_THREADS_DIR)) {
        const entries = fs.readdirSync(OUTPUT_THREADS_DIR, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory());
        diskFolderCount = dirs.length;

        for (const d of dirs) {
          const dirPath = path.join(OUTPUT_THREADS_DIR, d.name);
          try {
            const files = fs.readdirSync(dirPath);
            diskFilesCount += files.length;
          } catch {}
        }
      }
    } catch (fsErr) {
      console.warn("[user-history] Error reading threads disk folder:", fsErr);
    }

    // 4. Check memories
    let hasMemoryProfile = false;
    if (userId) {
      const userMemDir = path.join(MEMORY_BASE_DIR, userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_"));
      hasMemoryProfile = fs.existsSync(userMemDir);
    }

    return NextResponse.json({
      success: true,
      stats: {
        sessionCount,
        messageCount,
        threadCount,
        diskFolderCount,
        diskFilesCount,
        hasMemoryProfile,
        userId,
        userEmail,
      },
    });
  } catch (error: any) {
    console.error("[user-history] GET error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch user history stats" },
      { status: 500 }
    );
  }
}

// POST /api/user-history - Complete deletion of personal history from Supabase DB, LangGraph DB, and Disk
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const user = await getSupabaseUser(cookieStore);
    const admin = getSupabaseAdmin();

    let userId = user?.id || null;
    if (!userId && admin) {
      const { data: firstUser } = await admin
        .from("user_settings")
        .select("id")
        .limit(1)
        .maybeSingle();
      if (firstUser?.id) userId = firstUser.id;
    }

    const body = await request.json().catch(() => ({}));
    const {
      clearSessions = true,
      clearThreads = true,
      clearDiskFiles = true,
      clearMemories = false,
      clearChatBindings = true,
    } = body;

    const lgBase = getLangGraphApiUrl();
    let deletedSessionsCount = 0;
    let deletedMessagesCount = 0;
    let deletedThreadsCount = 0;
    let cancelledRunsCount = 0;
    let deletedFoldersCount = 0;
    let deletedFilesCount = 0;
    let bindingsDeleted = 0;
    let memoriesCleared = false;

    // 1. Delete from Supabase Database (sessions and messages)
    if (clearSessions && admin) {
      try {
        if (userId) {
          // Fetch sessions for user
          const { data: userSessions } = await admin
            .from("sessions")
            .select("id")
            .eq("user_id", userId);

          if (userSessions && userSessions.length > 0) {
            const sessionIds = userSessions.map((s: any) => s.id);

            // Delete messages
            const { count: delMCount } = await admin
              .from("messages")
              .delete({ count: "exact" })
              .in("session_id", sessionIds);
            deletedMessagesCount = delMCount ?? 0;

            // Delete sessions
            const { count: delSCount } = await admin
              .from("sessions")
              .delete({ count: "exact" })
              .eq("user_id", userId);
            deletedSessionsCount = delSCount ?? userSessions.length;
          }
        } else {
          // If no specific userId, delete all sessions/messages
          const { count: delMCount } = await admin
            .from("messages")
            .delete({ count: "exact" })
            .neq("id", "00000000-0000-0000-0000-000000000000");
          const { count: delSCount } = await admin
            .from("sessions")
            .delete({ count: "exact" })
            .neq("id", "00000000-0000-0000-0000-000000000000");
          deletedMessagesCount = delMCount ?? 0;
          deletedSessionsCount = delSCount ?? 0;
        }
      } catch (dbErr) {
        console.error("[user-history] Error deleting Supabase sessions/messages:", dbErr);
      }
    }

    // 2. Delete all LangGraph Threads & Checkpoints (Paginating until completely empty)
    if (clearThreads) {
      try {
        let keepSearching = true;
        let iteration = 0;

        while (keepSearching && iteration < 50) {
          iteration++;
          const searchPayload: Record<string, any> = {
            limit: 100,
          };
          if (userId) {
            searchPayload.metadata = { user_id: userId };
          }

          const searchRes = await fetch(`${lgBase}/threads/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(searchPayload),
            cache: "no-store",
          });

          let batch: any[] = [];
          if (searchRes.ok) {
            batch = await searchRes.json();
          }

          if (!Array.isArray(batch) || batch.length === 0) {
            keepSearching = false;
            break;
          }

          for (const thread of batch) {
            const tid = thread?.thread_id || thread?.id;
            if (!tid) continue;

            // Cancel any pending/running runs
            try {
              const runsRes = await fetch(`${lgBase}/threads/${tid}/runs?limit=10`, {
                cache: "no-store",
              });
              if (runsRes.ok) {
                const runs = await runsRes.json();
                if (Array.isArray(runs)) {
                  for (const run of runs) {
                    if (["pending", "running"].includes(run?.status)) {
                      await fetch(`${lgBase}/threads/${tid}/runs/${run.run_id}/cancel`, {
                        method: "POST",
                      }).catch(() => {});
                      cancelledRunsCount++;
                    }
                  }
                }
              }
            } catch {}

            // Delete the thread from LangGraph DB
            try {
              const delRes = await fetch(`${lgBase}/threads/${tid}`, {
                method: "DELETE",
              });
              if (delRes.ok || delRes.status === 404) {
                deletedThreadsCount++;
              }
            } catch (delErr) {
              console.warn(`[user-history] Failed to delete thread ${tid}:`, delErr);
            }

            // Delete corresponding thread folder on disk
            if (clearDiskFiles) {
              const safeTid = String(tid).replace(/[^a-zA-Z0-9_\-.]/g, "_");
              const threadDir = path.join(OUTPUT_THREADS_DIR, safeTid);
              if (fs.existsSync(threadDir)) {
                try {
                  const files = fs.readdirSync(threadDir);
                  deletedFilesCount += files.length;
                  fs.rmSync(threadDir, { recursive: true, force: true });
                  deletedFoldersCount++;
                } catch (fsErr) {
                  console.warn(`[user-history] Failed to delete directory ${threadDir}:`, fsErr);
                }
              }
            }
          }
        }
      } catch (lgErr) {
        console.error("[user-history] Error cleaning LangGraph threads:", lgErr);
      }
    }

    // 3. Clean remaining disk workspace folders if requested
    if (clearDiskFiles) {
      try {
        if (fs.existsSync(OUTPUT_THREADS_DIR)) {
          const entries = fs.readdirSync(OUTPUT_THREADS_DIR, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const dirPath = path.join(OUTPUT_THREADS_DIR, entry.name);
              try {
                const files = fs.readdirSync(dirPath);
                deletedFilesCount += files.length;
                fs.rmSync(dirPath, { recursive: true, force: true });
                deletedFoldersCount++;
              } catch {}
            }
          }
        }
      } catch (fsErr) {
        console.warn("[user-history] Error cleaning threads disk directory:", fsErr);
      }
    }

    // 4. Clean Supabase chat bindings
    if (admin && userId && clearChatBindings) {
      try {
        const { data: userWorkflows } = await admin
          .from("workflows")
          .select("id")
          .eq("user_id", userId);

        if (userWorkflows && userWorkflows.length > 0) {
          const wfIds = userWorkflows.map((w: any) => w.id);
          const { count } = await admin
            .from("telegram_chat_bindings")
            .delete({ count: "exact" })
            .in("workflow_id", wfIds);
          bindingsDeleted = count ?? 0;
        }
      } catch (dbErr) {
        console.warn("[user-history] Error cleaning telegram_chat_bindings:", dbErr);
      }
    }

    // 5. Clean user memories if requested
    if (admin && userId && clearMemories) {
      try {
        await admin
          .from("agent_settings")
          .delete()
          .eq("user_id", userId)
          .ilike("key", "memory_%");

        const cleanUser = userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        const userMemDir = path.join(MEMORY_BASE_DIR, cleanUser);
        if (fs.existsSync(userMemDir)) {
          fs.rmSync(userMemDir, { recursive: true, force: true });
        }
        memoriesCleared = true;
      } catch (memErr) {
        console.warn("[user-history] Error clearing memories:", memErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: "Personal history permanently deleted from Supabase Database, LangGraph checkpointer, and Disk.",
      summary: {
        deletedSessionsCount,
        deletedMessagesCount,
        deletedThreadsCount,
        cancelledRunsCount,
        deletedFoldersCount,
        deletedFilesCount,
        bindingsDeleted,
        memoriesCleared,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error("[user-history] POST error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to delete user personal history" },
      { status: 500 }
    );
  }
}
