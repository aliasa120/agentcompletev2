import { NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";

export async function POST() {
    try {
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
        const indexName = process.env.PINECONE_INDEX_NAME ?? "ai-news-feeder";
        const index = pc.index(indexName);
        // Delete all vectors — use namespace('') for default namespace
        try {
            await index.namespace("").deleteAll();
        } catch {
            // Fallback: some SDK versions use deleteAll() directly
            await (index as any).deleteAll();
        }
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}

