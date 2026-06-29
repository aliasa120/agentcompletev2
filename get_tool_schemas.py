import sys
import json
import asyncio
import os
from dotenv import load_dotenv

# Load env files from potential directories (root or deep-agents-ui-main)
load_dotenv(".env")
load_dotenv("../.env")
load_dotenv(".env.local")
load_dotenv("deep-agents-ui-main/.env.local")
load_dotenv("../deep-agents-ui-main/.env.local")

# Map Next.js public variables to standard variables for database connection
if not os.environ.get("SUPABASE_URL") and os.environ.get("NEXT_PUBLIC_SUPABASE_URL"):
    os.environ["SUPABASE_URL"] = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
if not os.environ.get("SUPABASE_ANON_KEY") and os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY"):
    os.environ["SUPABASE_ANON_KEY"] = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

from langchain_core.utils.function_calling import convert_to_openai_tool
from research_agent.tools.dynamic_router import TOOL_OBJECTS
from research_agent.tools.provider_engine import load_mcp_tool_by_key
from research_agent.tools.mcp_loader import run_sync


async def get_schemas(tool_names):
    schemas = {}
    for name in tool_names:
        tool_obj = TOOL_OBJECTS.get(name)
        if not tool_obj:
            try:
                # load_mcp_tool_by_key is an async function in provider_engine
                mcp_tools = await load_mcp_tool_by_key(name)
                if mcp_tools:
                    tool_obj = mcp_tools[0]
            except Exception as e:
                pass
        if tool_obj:
            try:
                schema_dict = convert_to_openai_tool(tool_obj)
                schemas[name] = schema_dict
            except Exception as e:
                # Fallback schema
                schemas[name] = {
                    "type": "function",
                    "function": {
                        "name": tool_obj.name,
                        "description": tool_obj.description or "",
                        "parameters": {
                            "type": "object",
                            "properties": tool_obj.args,
                            "required": list(tool_obj.args.keys())
                        }
                    }
                }
    return schemas

if __name__ == "__main__":
    tool_names = sys.argv[1:]
    if not tool_names:
        # If no arguments, return built-in tool list
        print(json.dumps({"tools": list(TOOL_OBJECTS.keys())}))
        sys.exit(0)
    
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        schemas = loop.run_until_complete(get_schemas(tool_names))
        print(json.dumps(schemas))
    finally:
        loop.close()
