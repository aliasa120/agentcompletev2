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
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { text, purpose = "mirror" } = await req.json();
    // Base64-encode the test text so Python receives it as a single safe string
    // literal — avoids SyntaxError when the text contains newlines, quotes,
    // emoji, or other characters that break direct string interpolation.
    const testText =
      text || "Hello! This is a live test of your text to speech configuration.";
    const testTextB64 = Buffer.from(testText, "utf-8").toString("base64");

    // Run python synthesis script with user's active context.
    // Try 'uv run python' first. On production servers where 'uv' is not installed in PATH
    // (causing spawn uv ENOENT), fall back to .venv/bin/python, python3, or python.
    const projectRoot = path.resolve(process.cwd(), "..");
    const pythonScript = [
      "from dotenv import load_dotenv",
      "load_dotenv()",
      "load_dotenv('deep-agents-ui-main/.env.local', override=False)",
      "import base64",
      "from research_agent.tts import get_tts_config, synthesize_speech, upload_audio",
      `cfg = get_tts_config("${user.id}", purpose="${purpose}")`,
      `test_text = base64.b64decode("${testTextB64}").decode("utf-8")`,
      `data, ext, mime, prov = synthesize_speech(test_text, platform="web", user_id="${user.id}", purpose="${purpose}")`,
      "url = upload_audio(data, ext, mime)",
      'voice = cfg.get("voice_id") or ""',
      'model = cfg.get("model_id") or ""',
      'b64 = base64.b64encode(data).decode("utf-8")',
      'print(f"PROVIDER:{prov}|VOICE:{voice}|MODEL:{model}|URL:{url}|AUDIO:{b64}")'
    ].join("; ");

    const execOpts = {
      cwd: projectRoot,
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    };

    let stdout = "";
    let stderr = "";

    try {
      const res = await execFileAsync("uv", ["run", "python", "-c", pythonScript], execOpts);
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (err: any) {
      if (err.code === "ENOENT" || err.message?.includes("ENOENT")) {
        // 'uv' is not installed or not in PATH on this server. Fallback to python executable.
        const fs = await import("fs");
        let pythonBin = "python3";
        const venvWin = path.join(projectRoot, ".venv", "Scripts", "python.exe");
        const venvNix = path.join(projectRoot, ".venv", "bin", "python");

        if (fs.existsSync(venvNix)) {
          pythonBin = venvNix;
        } else if (fs.existsSync(venvWin)) {
          pythonBin = venvWin;
        }

        try {
          const res = await execFileAsync(pythonBin, ["-c", pythonScript], execOpts);
          stdout = res.stdout;
          stderr = res.stderr;
        } catch (pyErr: any) {
          // If python3 fails with ENOENT, try 'python'
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

    if (!stdout.includes("PROVIDER:")) {
      console.error("[tts-test] Python output error:", stdout, stderr);
      return NextResponse.json({ error: stderr || stdout || "Synthesis failed" }, { status: 500 });
    }

    const provMatch = stdout.match(/PROVIDER:([^|]+)/);
    const voiceMatch = stdout.match(/VOICE:([^|]+)/);
    const modelMatch = stdout.match(/MODEL:([^|]+)/);
    const urlMatch = stdout.match(/URL:([^|]+)/);
    const audioMatch = stdout.match(/AUDIO:(.+)/);

    const provider = provMatch ? provMatch[1].trim() : "unknown";
    const voiceId = voiceMatch ? voiceMatch[1].trim() : "";
    const modelId = modelMatch ? modelMatch[1].trim() : "";
    const audioUrl = urlMatch ? urlMatch[1].trim() : "";
    const audioBase64 = audioMatch ? audioMatch[1].trim() : "";

    const finalUrl = audioUrl || `data:audio/mp3;base64,${audioBase64}`;

    return NextResponse.json({
      success: true,
      provider,
      voiceId,
      modelId,
      audioUrl: finalUrl,
    });
  } catch (e: any) {
    console.error("[tts-test] Error:", e);
    return NextResponse.json({ error: e.message || "Failed to generate test voice" }, { status: 500 });
  }
}
