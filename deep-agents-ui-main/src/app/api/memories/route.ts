import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Pinecone } from "@pinecone-database/pinecone";

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate user
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
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const workflowId = searchParams.get("workflow_id");
    const query = searchParams.get("query");

    if (!workflowId) {
      return NextResponse.json({ error: "workflow_id is required" }, { status: 400 });
    }

    // 2. Query Pinecone
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "PINECONE_API_KEY is not configured" }, { status: 500 });
    }

    const pc = new Pinecone({ apiKey });
    const indexName = process.env.PINECONE_INDEX_NAME || "memories";
    const index = pc.index(indexName);

    let matches: any[] = [];

    if (query && query.trim().length > 0) {
      // Semantic search: embed the query and find nearest vectors
      const embedResponse = await pc.inference.embed({
        model: "multilingual-e5-large",
        inputs: [query],
        parameters: { inputType: "query" }
      });
      const vector = (embedResponse.data[0] as any).values;

      const queryResponse = await index.query({
        vector,
        topK: 100,
        includeMetadata: true,
      });
      matches = queryResponse.matches ?? [];
    } else {
      // List all records without a vector (serverless-safe)
      // Use listPaginated to get all IDs, then fetch metadata in batches
      const allIds: string[] = [];
      let paginationToken: string | undefined = undefined;

      do {
        const listResponse: any = await (index as any).listPaginated({
          limit: 100,
          ...(paginationToken ? { paginationToken } : {}),
        });
        const vectors = listResponse.vectors ?? listResponse.results ?? [];
        for (const v of vectors) {
          if (v.id) allIds.push(v.id);
        }
        paginationToken = listResponse.pagination?.next ?? listResponse.nextToken ?? undefined;
      } while (paginationToken);

      // Fetch metadata in batches of 100 (guard: fetch requires at least 1 ID)
      for (let i = 0; i < allIds.length; i += 100) {
        const batch = allIds.slice(i, i + 100);
        if (batch.length === 0) continue;
        const fetched = await index.fetch({ ids: batch });
        for (const [id, record] of Object.entries(fetched.records ?? {})) {
          matches.push({ id, metadata: (record as any).metadata, score: 1 });
        }
      }

      // Early exit if index is empty — no memories to show
      if (allIds.length === 0) {
        return NextResponse.json({ memories: [] });
      }
    }

    // Helper: check if a memory belongs to the requested workflowId
    // Supports both old scope (UUID_workflowId with underscore) and
    // new sanitized scope (uuid-workflowId with hyphen)
    const workflowIdLower = workflowId.toLowerCase();
    const belongsToWorkflow = (memUserId: string) => {
      if (!memUserId) return false;
      const lower = memUserId.toLowerCase();
      return (
        lower === workflowIdLower ||
        lower.endsWith(`-${workflowIdLower}`) ||
        lower.endsWith(`_${workflowIdLower}`)
      );
    };

    const memories = matches
      .filter((m: any) => belongsToWorkflow(m.metadata?.user_id as string))
      .map((m: any) => ({
        id: m.id,
        text: (m.metadata?.data as string) || (m.metadata?.text as string) || "",
        created_at: (m.metadata?.created_at as string) || "",
        user_id: m.metadata?.user_id as string,
        score: m.score,
      }));

    return NextResponse.json({ memories });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // 1. Authenticate user
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
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const id = searchParams.get("id");
    const workflowId = searchParams.get("workflow_id");

    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "PINECONE_API_KEY is not configured" }, { status: 500 });
    }

    const pc = new Pinecone({ apiKey });
    const indexName = process.env.PINECONE_INDEX_NAME || "memories";
    const index = pc.index(indexName);

    if (id) {
      // Delete single memory by ID
      await index.deleteMany({ ids: [id] });

      // Clean up linked entities in memories-entities index
      try {
        const entitiesIndex = pc.index(`${indexName}-entities`);
        const allEntityIds: string[] = [];
        let paginationToken: string | undefined = undefined;

        do {
          const listResponse: any = await (entitiesIndex as any).listPaginated({
            limit: 100,
            ...(paginationToken ? { paginationToken } : {}),
          });
          const vectors = listResponse.vectors ?? listResponse.results ?? [];
          for (const v of vectors) {
            if (v.id) allEntityIds.push(v.id);
          }
          paginationToken = listResponse.pagination?.next ?? listResponse.nextToken ?? undefined;
        } while (paginationToken);

        const entitiesToDelete: string[] = [];
        for (let i = 0; i < allEntityIds.length; i += 100) {
          const batch = allEntityIds.slice(i, i + 100);
          if (batch.length === 0) continue;
          const fetched = await entitiesIndex.fetch({ ids: batch });
          for (const [entityId, record] of Object.entries(fetched.records ?? {})) {
            const linkedIds = (record as any).metadata?.linked_memory_ids;
            if (Array.isArray(linkedIds) && linkedIds.includes(id)) {
              entitiesToDelete.push(entityId);
            }
          }
        }

        if (entitiesToDelete.length > 0) {
          await entitiesIndex.deleteMany({ ids: entitiesToDelete });
        }
      } catch (err) {
        console.warn("[DELETE memories] Failed to clean up associated entities:", err);
      }

      return NextResponse.json({ success: true, message: `Memory ${id} deleted.` });
    }

    if (workflowId) {
      // List all record IDs (serverless-safe — no zero-vector query)
      const allIds: string[] = [];
      let paginationToken: string | undefined = undefined;

      do {
        const listResponse: any = await (index as any).listPaginated({
          limit: 100,
          ...(paginationToken ? { paginationToken } : {}),
        });
        const vectors = listResponse.vectors ?? listResponse.results ?? [];
        for (const v of vectors) {
          if (v.id) allIds.push(v.id);
        }
        paginationToken = listResponse.pagination?.next ?? listResponse.nextToken ?? undefined;
      } while (paginationToken);

      // Fetch metadata in batches and filter by workflowId
      const workflowIdLower = workflowId.toLowerCase();
      const belongsToWorkflow = (memUserId: string) => {
        if (!memUserId) return false;
        const lower = memUserId.toLowerCase();
        return (
          lower === workflowIdLower ||
          lower.endsWith(`-${workflowIdLower}`) ||
          lower.endsWith(`_${workflowIdLower}`)
        );
      };

      const idsToDelete: string[] = [];
      if (allIds.length > 0) {
        for (let i = 0; i < allIds.length; i += 100) {
          const batch = allIds.slice(i, i + 100);
          if (batch.length === 0) continue;
          const fetched = await index.fetch({ ids: batch });
          for (const [id, record] of Object.entries(fetched.records ?? {})) {
            const memUserId = (record as any).metadata?.user_id as string;
            if (belongsToWorkflow(memUserId)) {
              idsToDelete.push(id);
            }
          }
        }

        // Delete in batches of 1000
        for (let i = 0; i < idsToDelete.length; i += 1000) {
          await index.deleteMany({ ids: idsToDelete.slice(i, i + 1000) });
        }
      }

      // Also clean up entities belonging to this workflow in memories-entities index
      let entitiesDeletedCount = 0;
      try {
        const entitiesIndex = pc.index(`${indexName}-entities`);
        const allEntityIds: string[] = [];
        let entityPaginationToken: string | undefined = undefined;

        do {
          const listResponse: any = await (entitiesIndex as any).listPaginated({
            limit: 100,
            ...(entityPaginationToken ? { entityPaginationToken } : {}),
          });
          const vectors = listResponse.vectors ?? listResponse.results ?? [];
          for (const v of vectors) {
            if (v.id) allEntityIds.push(v.id);
          }
          entityPaginationToken = listResponse.pagination?.next ?? listResponse.nextToken ?? undefined;
        } while (entityPaginationToken);

        const entityIdsToDelete: string[] = [];
        if (allEntityIds.length > 0) {
          for (let i = 0; i < allEntityIds.length; i += 100) {
            const batch = allEntityIds.slice(i, i + 100);
            if (batch.length === 0) continue;
            const fetched = await entitiesIndex.fetch({ ids: batch });
            for (const [entityId, record] of Object.entries(fetched.records ?? {})) {
              const memUserId = (record as any).metadata?.user_id as string;
              if (belongsToWorkflow(memUserId)) {
                entityIdsToDelete.push(entityId);
              }
            }
          }

          entitiesDeletedCount = entityIdsToDelete.length;
          for (let i = 0; i < entityIdsToDelete.length; i += 1000) {
            await entitiesIndex.deleteMany({ ids: entityIdsToDelete.slice(i, i + 1000) });
          }
        }
      } catch (err) {
        console.warn("[DELETE memories] Failed to clean up entities for workflow:", err);
      }



      return NextResponse.json({
        success: true,
        message: `Cleared ${idsToDelete.length} memories and ${entitiesDeletedCount} entities for workflow ${workflowId}.`,
      });
    }

    return NextResponse.json({ error: "id or workflow_id is required" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
