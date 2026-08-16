import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }: any) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
}

// In-memory dedupe: messageId -> { url, provider }
const ttsCache = new Map<string, { url: string; provider: string }>();

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { text, messageId, threadId, platform = "web", purpose = "mirror", maxChars = 3000 } = await req.json();

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }
    if (!messageId || typeof messageId !== "string") {
      return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
    }

    // Idempotent: if same messageId already synthesized, return cached url.
    // Prevents duplicate work when the client re-triggers after a re-render.
    if (ttsCache.has(messageId)) {
      const cached = ttsCache.get(messageId)!;
      return NextResponse.json({ success: true, ...cached, voice: "", model: "", cached: true });
    }

    const cleanText = text.trim().slice(0, 6000);
    const cleanTextB64 = Buffer.from(cleanText, "utf-8").toString("base64");

    const projectRoot = path.resolve(process.cwd(), "..");
    const pythonScript = [
      "from dotenv import load_dotenv",
      "load_dotenv()",
      "load_dotenv('deep-agents-ui-main/.env.local', override=False)",
      "import base64",
      "from research_agent.tts import synthesize_reply_audio, extract_audio_markers",
      `b64='${cleanTextB64}'`,
      `raw=base64.b64decode(b64).decode('utf-8')`,
      `marker=synthesize_reply_audio(raw, platform='${platform}', user_id='${user.id}', purpose='${purpose}', max_chars=${Number(maxChars) || 3000})`,
      "if not marker:",
      "  print('NO_AUDIO')",
      "else:",
      "  url, is_voice, prov, cleaned = extract_audio_markers(marker)",
      "  print(f'URL:{url}')",
      "  print(f'PROV:{prov or \"\"}')",
    ].join("\n");

    const execOpts = {
      cwd: projectRoot,
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
    } as const;

    let stdout = "";
    let stderr = "";

    try {
      const res = await execFileAsync("uv", ["run", "python", "-c", pythonScript], execOpts);
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (err: any) {
      if (err.code === "ENOENT" || err.message?.includes("ENOENT")) {
        const fs = await import("fs");
        let pythonBin = "python3";
        const venvNix = path.join(projectRoot, ".venv", "bin", "python");
        const venvWin = path.join(projectRoot, ".venv", "Scripts", "python.exe");
        if (fs.existsSync(venvNix)) pythonBin = venvNix;
        else if (fs.existsSync(venvWin)) pythonBin = venvWin;
        try {
          const res = await execFileAsync(pythonBin, ["-c", pythonScript], execOpts);
          stdout = res.stdout;
          stderr = res.stderr;
        } catch (pyErr: any) {
          if (pyErr.code === "ENOENT" && pythonBin === "python3") {
            const res = await execFileAsync("python", ["-c", pythonScript], execOpts);
            stdout = res.stdout;
            stderr = res.stderr;
          } else {
            throw pyErr;
          }
        }
      } else {
        throw err;
      }
    }

    if (stdout.includes("NO_AUDIO")) {
      return NextResponse.json({ error: "No audio generated (empty text or synthesis failed)", detail: stderr || stdout }, { status: 500 });
    }

    // Stop at `|` or whitespace so a `|PROV:...` suffix is never captured into the URL.
    const urlMatch = stdout.match(/URL:([^|\s]+)/);
    const provMatch = stdout.match(/PROV:([^|\s]*)/);
    const url = urlMatch ? urlMatch[1].trim() : "";
    const provider = provMatch ? provMatch[1].trim() : "";

    if (!url) {
      console.error("[tts] synthesis returned no URL:", stdout, stderr);
      return NextResponse.json({ error: stderr || stdout || "Synthesis failed" }, { status: 500 });
    }

    const result = { url, provider };
    ttsCache.set(messageId, result);
    // cap cache to 500 entries
    if (ttsCache.size > 500) {
      const firstKey = ttsCache.keys().next().value as string;
      ttsCache.delete(firstKey);
    }

    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    console.error("[tts] Error:", e);
    return NextResponse.json({ error: e.message || "Failed to synthesize" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ info: "POST {text, messageId, threadId, platform?, purpose?, maxChars?} to synthesize TTS." });
}
