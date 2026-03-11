import { NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";

export async function GET() {
    try {
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
        const index = pc.index(process.env.PINECONE_INDEX_NAME ?? "ai-news-feeder");
        const stats = await index.describeIndexStats();
        return NextResponse.json({ totalRecordCount: stats.totalRecordCount ?? 0 });
    } catch (e: any) {
        return NextResponse.json({ totalRecordCount: 0, error: e.message });
    }
}
