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

    // Run python synthesis script with user's active context via execFile
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

    const { stdout, stderr } = await execFileAsync("uv", ["run", "python", "-c", pythonScript], {
      cwd: projectRoot,
      // MiMo TTS is a chat-completions call that can take 40-60s for long
      // texts; 30s was killing the process mid-synthesis.
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });

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
