"""MCP Loader — Connects to MCP servers (Composio + manual) and returns LangChain tools.

Supports:
1. Composio Gateway tools (authenticated via COMPOSIO_API_KEY).
2. Manual MCP servers (SSE endpoints).
"""

import os
import json
import asyncio
import logging
import threading
from typing import List, Dict, Any, Optional, Type
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger("mcp_loader")

class ZapierActionInput(BaseModel):
    instructions: str = Field(description="Natural language instructions for the action (e.g. 'Create a post with title Hello and status publish')")
    params: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Optional key-value parameters to forward directly to the action")
    output: Optional[str] = Field(default="URL or confirmation of the action", description="Description of what output/data you want back")

class ZapierActionTool(BaseTool):
    name: str
    description: str
    args_schema: Type[BaseModel] = ZapierActionInput
    
    server_config: Dict[str, Any] = Field(exclude=True)
    underlying_tool: str
    selected_api: str
    action_key: str

    def _run(self, *args, **kwargs):
        raise NotImplementedError("Use async run (_arun)")

    async def _arun(self, instructions: str, params: Optional[Dict[str, Any]] = None, output: Optional[str] = None, **kwargs):
        try:
            from langchain_mcp_adapters.client import MultiServerMCPClient
            client = MultiServerMCPClient(self.server_config)
            async with client.session("manual_server") as session:
                result = await session.call_tool(
                    self.underlying_tool,
                    {
                        "selected_api": self.selected_api,
                        "action": self.action_key,
                        "instructions": instructions,
                        "params": params or {},
                        "output": output or "status or result info"
                    }
                )
                if hasattr(result, "content"):
                    text_parts = []
                    for c in result.content:
                        if hasattr(c, "text"):
                            text_parts.append(c.text)
                        elif isinstance(c, dict) and "text" in c:
                            text_parts.append(c["text"])
                        else:
                            text_parts.append(str(c))
                    return "\n".join(text_parts)
                return str(result)
        except Exception as e:
            return f"Error executing Zapier action: {e}"

def run_sync(coro):
    """Run an async coroutine synchronously, safe for running event loops."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        result = []
        err = []
        def target():
            new_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(new_loop)
            try:
                result.append(new_loop.run_until_complete(coro))
            except Exception as e:
                err.append(e)
            finally:
                new_loop.close()
        t = threading.Thread(target=target)
        t.start()
        t.join()
        if err:
            raise err[0]
        return result[0]
    else:
        return asyncio.run(coro)


async def load_manual_mcp_tool(mcp_url: str, tool_key: str, metadata: Dict[str, Any] = None) -> List[BaseTool]:
    """Connect to a manual MCP server via SSE or Stdio and fetch the specified tool."""
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
        from langchain_mcp_adapters.tools import load_mcp_tools
    except ImportError:
        logger.warning("langchain-mcp-adapters not installed. Skipping manual tool loading.")
        return []
    # Try parsing mcp_url as JSON for custom stdio/sse configs
    config_data = None
    if mcp_url.strip().startswith("{"):
        try:
            config_data = json.loads(mcp_url)
        except Exception as je:
            logger.warning(f"Failed to parse mcp_url as JSON: {je}")

    # Inject authorization headers if connecting to Zapier MCP
    headers = {}
    mcp_url_str = mcp_url
    if config_data and isinstance(config_data, dict):
        mcp_url_str = config_data.get("url", mcp_url)

    is_zapier = mcp_url_str.startswith("https://mcp.zapier.com/")
    if is_zapier:
        zapier_secret = os.environ.get("ZAPIER_MCP_SECRET", "")
        if zapier_secret:
            headers["Authorization"] = f"Bearer {zapier_secret}"

    if config_data and isinstance(config_data, dict):
        transport = config_data.get("transport", "sse")
        if transport == "stdio":
            server_config = {
                "manual_server": {
                    "transport": "stdio",
                    "command": config_data.get("command"),
                    "args": config_data.get("args", []),
                    "env": config_data.get("env", {}),
                }
            }
        else:
            server_config = {
                "manual_server": {
                    "transport": "streamable-http" if is_zapier else transport,
                    "url": config_data.get("url", mcp_url),
                    "headers": headers,
                }
            }
    else:
        server_config = {
            "manual_server": {
                "transport": "streamable-http" if is_zapier else "sse",
                "url": mcp_url,
                "headers": headers,
            }
        }

    if metadata and isinstance(metadata, dict) and metadata.get("underlying_tool"):
        # Dynamic Zapier action wrapper
        wrapper_tool = ZapierActionTool(
            name=tool_key,
            description=f"Zapier tool to '{metadata.get('tool_name', tool_key)}'. Use this tool to interact with the integrated application. Provide detailed instructions.",
            server_config=server_config,
            underlying_tool=metadata.get("underlying_tool"),
            selected_api=metadata.get("selected_api"),
            action_key=metadata.get("action")
        )
        logger.info(f"Dynamically created wrapper Zapier tool: {tool_key}")
        return [wrapper_tool]

    client = MultiServerMCPClient(server_config)
    try:
        async with client.session("manual_server") as session:
            all_tools = await load_mcp_tools(session)
            # Find the tool with name matching tool_key
            matched = [t for t in all_tools if t.name == tool_key]
            if matched:
                logger.info(f"Loaded manual MCP tool: {tool_key} from server")
            else:
                logger.warning(f"Manual MCP tool '{tool_key}' not found on server. Available: {[t.name for t in all_tools]}")
            return matched
    except Exception as e:
        logger.error(f"Error loading manual MCP tool {tool_key} from {server_config}: {e}")
        return []


def load_mcp_tools_for_agent(agent_id: str) -> List[BaseTool]:
    """Fetch assigned MCP tools for an agent from Supabase and initialize them."""
    try:
        from supabase import create_client
    except ImportError:
        logger.warning("supabase package not installed. Cannot load MCP tools.")
        return []

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        logger.warning("SUPABASE_URL or SUPABASE_ANON_KEY not set. Cannot load MCP tools.")
        return []

    try:
        client = create_client(url, key)
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client in mcp_loader: {e}")
        return []

    # Get enabled MCP tool assignments for this agent
    try:
        resp = client.table("agent_tool_assignments")\
                     .select("tool_key,tool_label")\
                     .eq("agent_id", agent_id)\
                     .eq("tool_type", "mcp")\
                     .eq("enabled", True)\
                     .execute()
    except Exception as e:
        logger.error(f"Failed to fetch tool assignments: {e}")
        return []

    assignments = resp.data or []
    if not assignments:
        return []

    assigned_keys = {a["tool_key"] for a in assignments}
    logger.info(f"Loading {len(assigned_keys)} MCP tools for agent {agent_id}: {assigned_keys}")

    # Load active connections to classify tool_keys
    try:
        conn_resp = client.table("mcp_connections").select("*").eq("status", "active").execute()
        connections = conn_resp.data or []
    except Exception as e:
        logger.error(f"Failed to fetch active MCP connections: {e}")
        connections = []

    composio_keys = []
    manual_tools_to_load = []

    for tool_key in assigned_keys:
        found_manual = False
        for conn in connections:
            if conn.get("connection_type") == "manual":
                tools_list = conn.get("available_tools") or []
                for t in tools_list:
                    if isinstance(t, dict) and t.get("tool_key") == tool_key:
                        manual_tools_to_load.append((conn.get("mcp_url"), tool_key, t))
                        found_manual = True
                        break
                    elif isinstance(t, str) and t == tool_key:
                        manual_tools_to_load.append((conn.get("mcp_url"), tool_key, None))
                        found_manual = True
                        break
                if found_manual:
                    break

        if not found_manual:
            composio_keys.append(tool_key)

    loaded_tools: List[BaseTool] = []

    # 1. Load Composio tools
    if composio_keys:
        composio_api_key = os.environ.get("COMPOSIO_API_KEY", "")
        if composio_api_key:
            try:
                from composio import Composio
                from composio_langchain import LangchainProvider
                composio = Composio(api_key=composio_api_key, provider=LangchainProvider())
                comp_tools = composio.tools.get(user_id="default", tools=composio_keys)
                loaded_tools.extend(comp_tools)
                logger.info(f"Loaded {len(comp_tools)} Composio tools")
                try:
                    with open("agent_load.log", "a", encoding="utf-8") as f:
                        f.write(f"[mcp_loader] Loaded {len(comp_tools)} Composio tools for agent {agent_id}: {[t.name for t in comp_tools]}\n")
                except Exception:
                    pass
            except Exception as e:
                logger.warning(f"Failed to load Composio tools: {e}")
                try:
                    with open("agent_load.log", "a", encoding="utf-8") as f:
                        import traceback
                        f.write(f"[mcp_loader] Failed to load Composio tools for agent {agent_id}: {e}\n{traceback.format_exc()}\n")
                except Exception:
                    pass
        else:
            logger.warning("COMPOSIO_API_KEY not set. Skipping Composio tools.")
            try:
                with open("agent_load.log", "a", encoding="utf-8") as f:
                    f.write(f"[mcp_loader] COMPOSIO_API_KEY not set in environ for agent {agent_id}. Keys: {[k for k in os.environ.keys() if 'COMPOSIO' in k]}\n")
            except Exception:
                pass

    # 2. Load manual MCP tools
    if manual_tools_to_load:
        for mcp_url, tool_key, metadata in manual_tools_to_load:
            if not mcp_url:
                continue
            try:
                tools = run_sync(load_manual_mcp_tool(mcp_url, tool_key, metadata))
                loaded_tools.extend(tools)
            except Exception as e:
                logger.warning(f"Error loading manual tool {tool_key} from {mcp_url}: {e}")

    return loaded_tools
