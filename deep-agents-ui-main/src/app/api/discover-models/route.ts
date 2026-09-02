import { NextRequest, NextResponse } from "next/server";

// POST /api/discover-models — queries ${base_url}/models to auto-discover model list
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let baseUrl: string = (body.base_url || "").trim();
    const apiKey: string = (body.api_key || "").trim();

    if (!baseUrl) {
      return NextResponse.json({ success: false, error: "Base URL is required." }, { status: 400 });
    }

    // Clean base url
    baseUrl = baseUrl.replace(/\/+$/, "");
    const modelsEndpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    console.log(`[discover-models] → Fetching models from ${modelsEndpoint}`);

    const resp = await fetch(modelsEndpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      let errText = "";
      try { errText = await resp.text(); } catch {}
      return NextResponse.json({
        success: false,
        error: `Server returned HTTP ${resp.status}: ${errText.slice(0, 200) || resp.statusText}`,
      }, { status: 400 });
    }

    const data = await resp.json();
    let modelList: string[] = [];

    if (Array.isArray(data.data)) {
      modelList = data.data.map((m: any) => m.id || m.name).filter(Boolean);
    } else if (Array.isArray(data.models)) {
      modelList = data.models.map((m: any) => m.name || m.id || m.model).filter(Boolean);
    } else if (Array.isArray(data)) {
      modelList = data.map((m: any) => typeof m === "string" ? m : m.id || m.name).filter(Boolean);
    }

    // Deduplicate and sort
    const uniqueModels = Array.from(new Set(modelList)).sort();

    return NextResponse.json({
      success: true,
      models: uniqueModels,
      count: uniqueModels.length,
    });
  } catch (err: any) {
    console.error("[discover-models] Error:", err);
    return NextResponse.json({
      success: false,
      error: err.message || "Failed to reach endpoint",
    }, { status: 500 });
  }
}
