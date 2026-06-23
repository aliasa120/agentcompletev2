import os
import sys
import io
import time
from dotenv import load_dotenv

# Reconfigure stdout/stderr to use UTF-8 on Windows consoles to prevent UnicodeEncodeError
if sys.platform.startswith("win"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

# Ensure the root directory is on the path so we can import from research_agent
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from research_agent.tools.dynamic_router import (
    TOOLS_METADATA,
    TOOL_OBJECTS,
    get_embedding_sync,
    _get_pinecone_index,
    generate_tool_metadata
)

def build_embedding_text(tool_name: str, meta: dict) -> str:
    """Combine metadata fields into a structured text document to be embedded."""
    keywords_str = ", ".join(meta.get("keywords", []))
    triggers_str = " | ".join(meta.get("example_triggers", []))
    return (
        f"Tool Name: {tool_name}\n"
        f"Description: {meta.get('short_description', '')}\n"
        f"Keywords: {keywords_str}\n"
        f"Example Triggers: {triggers_str}"
    )

def main():
    print("🚀 Initializing Dynamic Tool Seeder (Sync Mode)...")
    load_dotenv()

    # Validate environment variables
    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        print("❌ Error: PINECONE_API_KEY is not set in .env")
        sys.exit(1)

    print("🔌 Connecting to Pinecone...")
    try:
        index = _get_pinecone_index()
        # Verify connection by fetching stats
        stats = index.describe_index_stats()
        print(f"✅ Connected to index tools. Current stats: {stats}")
    except Exception as e:
        print(f"❌ Error connecting to index tools: {e}")
        print("Please verify that the Pinecone index 'tools' exists and is ready.")
        sys.exit(1)

    # 1. Gather all built-in tools
    tools_to_index = {}
    for name, tool_obj in TOOL_OBJECTS.items():
        if name in TOOLS_METADATA:
            tools_to_index[name] = TOOLS_METADATA[name].copy()
        else:
            desc = tool_obj.description.split("\n")[0][:120] if tool_obj.description else "Built-in agent tool."
            tools_to_index[name] = {
                "short_description": desc,
                "needs_llm_metadata": True
            }

    # 2. Gather active MCP tools from Supabase
    mcp_tools = []
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_ANON_KEY")
    if supabase_url and supabase_key:
        try:
            print("🗄️ Fetching active MCP tools from Supabase...")
            from supabase import create_client
            client = create_client(supabase_url, supabase_key)
            resp = client.table("mcp_connections").select("*").eq("status", "active").execute()
            connections = resp.data or []
            for conn in connections:
                available = conn.get("available_tools") or []
                for t in available:
                    if isinstance(t, dict):
                        mcp_tools.append({
                            "tool_name": t.get("tool_key"),
                            "description": t.get("description") or t.get("tool_name") or "External MCP Tool"
                        })
                    elif isinstance(t, str):
                        mcp_tools.append({
                            "tool_name": t,
                            "description": f"External MCP tool: {t}"
                        })
            print(f"✅ Retrieved {len(mcp_tools)} MCP tools from Supabase.")
        except Exception as e:
            print(f"⚠️ Failed to fetch MCP tools from Supabase: {e}")
    else:
        print("⚠️ Supabase credentials missing in .env. Skipping external MCP tool fetching.")

    # 3. Add MCP tools to index queue
    for mt in mcp_tools:
        name = mt["tool_name"]
        if name not in tools_to_index:
            tools_to_index[name] = {
                "short_description": mt["description"],
                "needs_llm_metadata": True
            }

    # 4. Generate LLM metadata for tools lacking keywords/triggers
    print(f"\n🧠 Resolving metadata and embedding {len(tools_to_index)} tools...")
    vectors_to_upsert = []
    
    for tool_name, meta in tools_to_index.items():
        if meta.get("needs_llm_metadata"):
            print(f"   • Generating LLM keywords/triggers for '{tool_name}'...")
            try:
                enriched = generate_tool_metadata(tool_name, meta["short_description"])
                meta.update(enriched)
                # Remove temporary key
                meta.pop("needs_llm_metadata", None)
            except Exception as e:
                print(f"     ⚠️ LLM metadata generation failed for '{tool_name}': {e}. Using fallbacks.")
                meta["keywords"] = [tool_name.replace("_", " ")]
                meta["example_triggers"] = [f"execute {tool_name}"]

        print(f"   • Embedding '{tool_name}'...")
        try:
            doc_text = build_embedding_text(tool_name, meta)
            vector = get_embedding_sync(doc_text, input_type="passage")
            
            if len(vector) != 1024:
                print(f"❌ Error: Embedding dimension is {len(vector)}, expected 1024.")
                sys.exit(1)

            vectors_to_upsert.append({
                "id": tool_name,
                "values": vector,
                "metadata": {
                    "tool_name": tool_name,
                    "short_description": meta["short_description"],
                    "keywords": meta["keywords"],
                    "example_triggers": meta["example_triggers"]
                }
            })
            # Respect rate limits
            time.sleep(0.5)
        except Exception as e:
            print(f"❌ Failed to embed '{tool_name}': {e}")
            sys.exit(1)

    print(f"\n📤 Upserting {len(vectors_to_upsert)} vectors to Pinecone index 'tools'...")
    try:
        upsert_response = index.upsert(vectors=vectors_to_upsert)
        print(f"✅ Successfully seeded and synced all tools! Response: {upsert_response}")
    except Exception as e:
        print(f"❌ Failed to upsert vectors to Pinecone: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
