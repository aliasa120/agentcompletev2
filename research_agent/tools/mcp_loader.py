"""MCP Loader — Connects to MCP servers (Composio + manual) and returns LangChain tools.

Supports:
1. Composio Gateway tools (authenticated via COMPOSIO_API_KEY).
2. Manual MCP servers (SSE endpoints).
"""

import os
import tempfile
import json
import asyncio
import logging
import threading
import re
from typing import List, Dict, Any, Optional, Type
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
import mcp.types
import shutil
import sys
from contextlib import asynccontextmanager

logger = logging.getLogger("mcp_loader")

# --- McpError Safety Monkeypatch ---
try:
    from mcp.shared.exceptions import McpError
    from mcp.types import ErrorData

    _original_mcp_error_init = McpError.__init__

    def _patched_mcp_error_init(self, error):
        if isinstance(error, str):
            error = ErrorData(code=-32000, message=error)
        elif not hasattr(error, "message") and isinstance(error, dict):
            error = ErrorData(
                code=error.get("code", -32000),
                message=error.get("message", str(error)),
                data=error.get("data")
            )
        elif error is None:
            error = ErrorData(code=-32000, message="Unknown MCP error")
        _original_mcp_error_init(self, error)

    McpError.__init__ = _patched_mcp_error_init
    logger.info("Successfully monkeypatched McpError.__init__ for payload safety.")
except Exception as patch_err:
    logger.warning(f"Failed to monkeypatch McpError.__init__: {patch_err}")

# --- Stdio Subprocess Stderr Log Redirection ---
_mcp_stderr_log_fh = None
_mcp_stderr_log_lock = threading.Lock()

def _get_mcp_stderr_log() -> Any:
    """Return a shared append-mode file handle for MCP subprocess stderr."""
    global _mcp_stderr_log_fh
    with _mcp_stderr_log_lock:
        if _mcp_stderr_log_fh is not None:
            return _mcp_stderr_log_fh
        try:
            log_dir = "logs"
            os.makedirs(log_dir, exist_ok=True)
            log_path = os.path.join(log_dir, "mcp-stderr.log")
            fh = open(log_path, "a", encoding="utf-8", errors="replace", buffering=1)
            fh.fileno() # Confirm real fd is available
            _mcp_stderr_log_fh = fh
        except Exception as exc:
            logger.debug(f"Failed to open MCP stderr log: {exc}")
            try:
                _mcp_stderr_log_fh = open(os.devnull, "w", encoding="utf-8")
            except Exception:
                _mcp_stderr_log_fh = sys.stderr
        return _mcp_stderr_log_fh

def _write_stderr_log_header(server_name: str) -> None:
    """Write a human-readable session marker before launching a server."""
    fh = _get_mcp_stderr_log()
    try:
        from datetime import datetime
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        fh.write(f"\n===== [{ts}] starting MCP server '{server_name}' =====\n")
        fh.flush()
    except Exception:
        pass

# Globally monkeypatch mcp.client.stdio.stdio_client to redirect stderr to file
try:
    import mcp.client.stdio
    _original_stdio_client = mcp.client.stdio.stdio_client

    @asynccontextmanager
    async def _patched_stdio_client(server_parameters, *args, **kwargs):
        errlog_fh = _get_mcp_stderr_log()
        _write_stderr_log_header(server_parameters.command)
        kwargs["errlog"] = errlog_fh
        async with _original_stdio_client(server_parameters, *args, **kwargs) as streams:
            yield streams

    mcp.client.stdio.stdio_client = _patched_stdio_client
    logger.info("Successfully monkeypatched mcp.client.stdio.stdio_client for stderr redirection.")
except Exception as patch_err:
    logger.warning(f"Failed to monkeypatch stdio_client: {patch_err}")

# --- Command Path Resolution Helpers ---
def _prepend_path(env: dict, directory: str) -> dict:
    updated = dict(env or {})
    if not directory:
        return updated
    existing = updated.get("PATH", "")
    parts = [part for part in existing.split(os.pathsep) if part]
    if directory not in parts:
        parts = [directory, *parts]
    updated["PATH"] = os.pathsep.join(parts) if parts else directory
    return updated

def _resolve_stdio_command(command: str, env: dict) -> tuple[str, dict]:
    """Resolve a stdio MCP command and dynamically inject directory to PATH."""
    try:
        from blockbuster.blockbuster import blockbuster_skip
        skip_token = blockbuster_skip.set(True)
    except Exception:
        skip_token = None

    try:
        resolved_command = os.path.expanduser(str(command).strip())
        resolved_env = dict(env or {})

        if os.sep not in resolved_command:
            path_arg = resolved_env.get("PATH")
            which_hit = shutil.which(resolved_command, path=path_arg)
            if which_hit:
                resolved_command = which_hit
            elif resolved_command in {"npx", "npm", "node"}:
                home = os.path.expanduser("~")
                candidates = [
                    os.path.join(home, ".local", "bin", resolved_command),
                    os.path.join(os.sep, "usr", "local", "bin", resolved_command),
                ]
                for candidate in candidates:
                    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                        resolved_command = candidate
                        break

        command_dir = os.path.dirname(resolved_command)
        if command_dir:
            resolved_env = _prepend_path(resolved_env, command_dir)

        return resolved_command, resolved_env
    finally:
        if skip_token is not None:
            try:
                blockbuster_skip.reset(skip_token)
            except Exception:
                pass

# --- Environment Sandboxing Definitions ---
_SAFE_ENV_KEYS = frozenset({
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
    "NPM_CONFIG_CACHE",
})

_SAFE_ENV_KEYS_CASE_INSENSITIVE = frozenset({
    "ALLUSERSPROFILE",
    "APPDATA",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "COMPUTERNAME",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PUBLIC",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
})

def _build_safe_env(user_env: Optional[Dict[str, str]]) -> Dict[str, str]:
    """Build a filtered environment dict for stdio subprocesses to prevent leaking API keys."""
    env = {}
    for key, value in os.environ.items():
        if (
            key in _SAFE_ENV_KEYS
            or key.upper() in _SAFE_ENV_KEYS_CASE_INSENSITIVE
            or key.startswith("XDG_")
        ):
            env[key] = value
    if user_env:
        for k, v in user_env.items():
            if v is not None:
                env[k] = str(v)

    # Auto-inject shared caching for Docker containers
    if os.path.exists("/app/shared_npm_cache"):
        env["NPM_CONFIG_CACHE"] = "/app/shared_npm_cache"
        env["HOME"] = "/app/shared_npm_cache"

    # Auto-inject CI non-interactive variables to bypass telemetry/confirmations
    env["CI"] = "true"
    env["npm_config_yes"] = "true"

    # Shebang-proofing: Remove .JS and .JSE from PATHEXT on Windows to avoid Windows Script Host execution
    if os.name == 'nt' and 'PATHEXT' in env:
        pathext_list = env['PATHEXT'].split(';')
        filtered_pathext = [ext for ext in pathext_list if ext.strip().upper() not in ('.JS', '.JSE')]
        env['PATHEXT'] = ';'.join(filtered_pathext)

    return env

# --- Credential Redaction Definitions ---
_CREDENTIAL_PATTERN = re.compile(
    r"(?:"
    r"ghp_[A-Za-z0-9_]{1,255}"           # GitHub PAT
    r"|sk-[A-Za-z0-9_]{1,255}"           # OpenAI-style key
    r"|Bearer\s+\S+"                      # Bearer token
    r"|token=[^\s&,;\"']{1,255}"         # token=...
    r"|key=[^\s&,;\"']{1,255}"           # key=...
    r"|API_KEY=[^\s&,;\"']{1,255}"       # API_KEY=...
    r"|password=[^\s&,;\"']{1,255}"      # password=...
    r"|secret=[^\s&,;\"']{1,255}"        # secret=...
    r")",
    re.IGNORECASE,
)

def sanitize_credentials(text: str) -> str:
    """Strip credential-like patterns from text to prevent leaking API keys/tokens."""
    if not isinstance(text, str):
        return text
    return _CREDENTIAL_PATTERN.sub("[REDACTED]", text)

def _safe_reraise(exc: Exception) -> Exception:
    """Re-raise an exception with a sanitized message, safely handling exceptions
    whose constructors require multiple positional arguments (e.g. json.JSONDecodeError
    requires msg, doc, pos — calling JSONDecodeError(msg) alone raises TypeError).
    
    Strategy: try to reconstruct via type(e)(msg); if that fails, fall back to
    wrapping in a plain RuntimeError so the sanitized message is always preserved.
    """
    sanitized_msg = sanitize_credentials(str(exc))
    try:
        new_exc = type(exc)(sanitized_msg)
        new_exc.__traceback__ = exc.__traceback__
        return new_exc
    except TypeError:
        # Constructor needs more args than just the message string
        wrapper = RuntimeError(sanitized_msg)
        wrapper.__cause__ = None
        wrapper.__traceback__ = exc.__traceback__
        return wrapper


def wrap_tool_with_redaction(tool: BaseTool) -> BaseTool:
    """Wraps a LangChain tool's execution to redact credentials from outputs and error messages."""
    import functools
    orig_arun = tool._arun
    orig_run = tool._run

    @functools.wraps(orig_run)
    def redacted_run(*args, **kwargs):
        try:
            from blockbuster.blockbuster import blockbuster_skip
            skip_token = blockbuster_skip.set(True)
        except Exception:
            skip_token = None

        try:
            res = orig_run(*args, **kwargs)
            return sanitize_credentials(str(res)) if isinstance(res, str) else res
        except Exception as e:
            raise _safe_reraise(e) from None
        finally:
            if skip_token is not None:
                try:
                    blockbuster_skip.reset(skip_token)
                except Exception:
                    pass

    @functools.wraps(orig_arun)
    async def redacted_arun(*args, **kwargs):
        try:
            from blockbuster.blockbuster import blockbuster_skip
            skip_token = blockbuster_skip.set(True)
        except Exception:
            skip_token = None

        try:
            res = await orig_arun(*args, **kwargs)
            return sanitize_credentials(str(res)) if isinstance(res, str) else res
        except Exception as e:
            raise _safe_reraise(e) from None
        finally:
            if skip_token is not None:
                try:
                    blockbuster_skip.reset(skip_token)
                except Exception:
                    pass

    tool._arun = redacted_arun
    tool._run = redacted_run
    return tool

# --- MCP Sampling Callback Handler ---
_sampling_states = {}
_sampling_lock = threading.Lock()

class SamplingState:
    def __init__(self):
        self.timestamps = []
        self.tool_loop_count = 0

async def handle_sampling_request(ctx, params, server_name: str = "unknown") -> Any:
    """Handle a sampling/createMessage request from an MCP server by querying our LLM,
    guarded by a rate-limiter and loop recursion check.
    """
    import time
    from mcp.types import CreateMessageResult, TextContent

    now = time.time()
    window = now - 60

    # Rate limiting & Loop Guard
    with _sampling_lock:
        if server_name not in _sampling_states:
            _sampling_states[server_name] = SamplingState()
        state = _sampling_states[server_name]

        # Filter sliding window timestamps
        state.timestamps = [t for t in state.timestamps if t > window]
        if len(state.timestamps) >= 10:
            logger.warning(f"MCP server '{server_name}' rate-limited: exceeded 10 sampling requests/min.")
            raise RuntimeError(f"Rate limit exceeded for sampling requests on server '{server_name}'")
        state.timestamps.append(now)

        # Count tool usage loops to prevent runaway recursive calls
        has_tool_calls = False
        messages = getattr(params, "messages", [])
        for msg in messages:
            content_obj = getattr(msg, "content", None)
            if content_obj:
                if hasattr(content_obj, "type") and getattr(content_obj, "type") == "tool_use":
                    has_tool_calls = True
                    break
                elif isinstance(content_obj, dict) and content_obj.get("type") == "tool_use":
                    has_tool_calls = True
                    break

        if has_tool_calls:
            state.tool_loop_count += 1
            if state.tool_loop_count > 5:
                state.tool_loop_count = 0 # reset
                logger.warning(f"MCP server '{server_name}' loop-guard triggered: exceeded 5 tool rounds.")
                raise RuntimeError(f"Tool loop limit (5 rounds) exceeded on server '{server_name}'")
        else:
            state.tool_loop_count = 0 # reset on normal text response

    try:
        from langchain_openai import ChatOpenAI
        from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
        from research_agent.tools.provider_engine import get_llm_config

        langchain_messages = []
        if getattr(params, "systemPrompt", None):
            langchain_messages.append(SystemMessage(content=params.systemPrompt))

        messages = getattr(params, "messages", [])
        for msg in messages:
            role = getattr(msg, "role", "user")
            content_obj = getattr(msg, "content", None)
            content_text = ""
            if content_obj:
                if hasattr(content_obj, "text"):
                    content_text = content_obj.text
                elif isinstance(content_obj, dict) and "text" in content_obj:
                    content_text = content_obj["text"]
                elif hasattr(content_obj, "type") and content_obj.type == "text":
                    content_text = getattr(content_obj, "text", "")
                else:
                    content_text = str(content_obj)

            if role == "user":
                langchain_messages.append(HumanMessage(content=content_text))
            elif role == "assistant":
                langchain_messages.append(AIMessage(content=content_text))

        base_url, api_key, model_name = get_llm_config("main_agent")
        
        chat = ChatOpenAI(
            model=model_name,
            api_key=api_key,
            base_url=base_url,
            temperature=getattr(params, "temperature", 0.45) or 0.45,
            max_tokens=getattr(params, "maxTokens", 1024) or 1024,
        )

        res = await chat.ainvoke(langchain_messages)

        return CreateMessageResult(
            role="assistant",
            content=TextContent(type="text", text=res.content),
            model=model_name,
            stopReason="endTurn"
        )
    except Exception as e:
        logger.error(f"Error handling sampling request: {e}", exc_info=True)
        from mcp.types import CreateMessageResult, TextContent
        return CreateMessageResult(
            role="assistant",
            content=TextContent(type="text", text=f"Error in client sampling: {e}"),
            model="fallback",
            stopReason="stop"
        )


class ZapierActionInput(BaseModel):
    instructions: str = Field(description="Natural language instructions for the action (e.g. 'Create a post with title Hello and status publish')")
    params: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Optional key-value parameters to forward directly to the action")
    output: Optional[str] = Field(default="URL or confirmation of the action", description="Description of what output/data you want back")

class ZapierActionTool(BaseTool):
    name: str
    description: str
    args_schema: Type[BaseModel] = ZapierActionInput
    
    server_url: str = Field(default="")
    headers: Dict[str, str] = Field(default_factory=dict)
    underlying_tool: str
    selected_api: str
    action_key: str

    def _run(self, *args, **kwargs):
        raise NotImplementedError("Use async run (_arun)")

    async def _arun(self, instructions: str = "", params: Optional[Dict[str, Any]] = None, output: Optional[str] = None, **kwargs):
        try:
            import httpx
            # Ensure zapier secret header is attached
            if "Authorization" not in self.headers and self.server_url.startswith("https://mcp.zapier.com/"):
                from research_agent.tools.provider_engine import get_user_api_key
                sec = get_user_api_key("zapier_mcp_secret")
                if sec:
                    self.headers["Authorization"] = f"Bearer {sec}"
            
            post_headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                **self.headers
            }
            
            call_instructions = instructions or kwargs.get("instructions", "")
            if not call_instructions and kwargs:
                call_instructions = json.dumps(kwargs)

            call_params = params or {}
            for k, v in kwargs.items():
                if k not in ("selected_api", "action", "instructions", "output", "params"):
                    call_params[k] = v

            post_body = {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": self.underlying_tool,
                    "arguments": {
                        "selected_api": self.selected_api,
                        "action": self.action_key,
                        "instructions": call_instructions,
                        "params": call_params,
                        **call_params
                    }
                },
                "id": 1
            }

            async with httpx.AsyncClient(timeout=45.0) as client:
                res = await client.post(self.server_url, headers=post_headers, json=post_body)
                raw_text = res.text
                data = None
                try:
                    data = res.json()
                except Exception:
                    for line in raw_text.splitlines():
                        if line.startswith("data:"):
                            try:
                                data = json.loads(line[5:].strip())
                                break
                            except Exception:
                                pass
                if not data:
                    return sanitize_credentials(raw_text)
                if "error" in data:
                    return sanitize_credentials(f"Error executing Zapier action: {data['error']}")
                result = data.get("result", {})
                content = result.get("content", [])
                text_parts = []
                for c in content:
                    if isinstance(c, dict):
                        text_parts.append(c.get("text", json.dumps(c)))
                    else:
                        text_parts.append(str(c))
                return sanitize_credentials("\n".join(text_parts) if text_parts else json.dumps(result))
        except Exception as e:
            return sanitize_credentials(f"Error executing Zapier action: {e}")

def run_sync(coro):
    """Run an async coroutine synchronously, safe for nested event loops."""
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
        try:
            from blockbuster.blockbuster import blockbuster_skip
            skip_token = blockbuster_skip.set(True)
        except Exception:
            skip_token = None

        try:
            t.join()
        finally:
            if skip_token is not None:
                try:
                    blockbuster_skip.reset(skip_token)
                except Exception:
                    pass

        if err:
            raise err[0]
        return result[0]
    else:
        return asyncio.run(coro)



_manual_mcp_tools_cache: Dict[str, List[BaseTool]] = {}

async def load_manual_mcp_tool(mcp_url: str, tool_key: str, metadata: Dict[str, Any] = None) -> List[BaseTool]:
    """Connect to a manual MCP server via SSE or Stdio and fetch the specified tool."""
    cache_key = mcp_url.strip()
    if cache_key in _manual_mcp_tools_cache:
        matched = [t for t in _manual_mcp_tools_cache[cache_key] if t.name == tool_key]
        if matched:
            return [matched[0]]

    # Intercept virtual memory tools (add_memory, replace_memory, remove_memory, etc.)
    from research_agent.tools.dynamic_router import TOOL_OBJECTS
    if tool_key in TOOL_OBJECTS:
        return [TOOL_OBJECTS[tool_key]]

    # Intercept Zapier action wrapper tools (e.g. google_forms_make_api_get_request, gmail_send_email)
    if metadata and isinstance(metadata, dict) and metadata.get("underlying_tool"):
        base_url = mcp_url.split("#")[0]
        headers = {}
        if base_url.startswith("https://mcp.zapier.com/"):
            from research_agent.tools.provider_engine import get_user_api_key
            zapier_secret = get_user_api_key("zapier_mcp_secret")
            if zapier_secret:
                headers["Authorization"] = f"Bearer {zapier_secret}"

        wrapper_tool = ZapierActionTool(
            name=tool_key,
            description=f"Zapier tool to '{metadata.get('tool_name', tool_key)}' ({metadata.get('app', 'Zapier')}). Provide detailed instructions or parameters.",
            server_url=base_url,
            headers=headers,
            underlying_tool=metadata.get("underlying_tool"),
            selected_api=metadata.get("selected_api") or "",
            action_key=metadata.get("action") or "_zap_raw_request"
        )
        logger.info(f"Dynamically created wrapper Zapier tool: {tool_key}")
        return [wrap_tool_with_redaction(wrapper_tool)]

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
        from langchain_mcp_adapters.tools import load_mcp_tools
    except ImportError:
        logger.warning("langchain-mcp-adapters not installed. Skipping manual tool loading.")
        return []
    # Try parsing mcp_url as JSON for custom stdio/sse/http configs
    config_data = None
    if mcp_url.strip().startswith("{"):
        try:
            parsed = json.loads(mcp_url)
            # Support Claude Desktop format
            if isinstance(parsed, dict):
                if "mcpServers" in parsed and isinstance(parsed["mcpServers"], dict):
                    server_names = list(parsed["mcpServers"].keys())
                    if server_names:
                        server_name = server_names[0]
                        server_config = parsed["mcpServers"][server_name]
                        config_data = {
                            "transport": "stdio",
                            "command": server_config.get("command"),
                            "args": server_config.get("args", []),
                            "env": server_config.get("env", {})
                        }
                else:
                    # Look for a nested config under a single server name key
                    nested_config = None
                    metadata_keys = {"description", "mcp_version", "transport", "url", "headers"}
                    for k, v in parsed.items():
                        if k not in metadata_keys and isinstance(v, dict):
                            if "command" in v or "url" in v:
                                nested_config = v
                                break
                    
                    if nested_config:
                        config_data = {
                            "transport": parsed.get("transport") or nested_config.get("transport") or ("stdio" if "command" in nested_config else "sse"),
                            "command": nested_config.get("command"),
                            "args": nested_config.get("args", []),
                            "env": nested_config.get("env", {})
                        }
                        if "url" in nested_config:
                            config_data["url"] = nested_config["url"]
                        if "headers" in nested_config:
                            config_data["headers"] = nested_config["headers"]
                    else:
                        # Flat format
                        config_data = parsed
        except Exception as je:
            logger.warning(f"Failed to parse mcp_url as JSON: {je}")

    # Translate Windows-specific shell wrappers (cmd /c) to direct commands on non-Windows platforms
    if config_data and isinstance(config_data, dict) and config_data.get("transport") == "stdio" and os.name != "nt":
        cmd_val = config_data.get("command")
        args_val = config_data.get("args") or []
        if cmd_val == "cmd" and len(args_val) > 0 and args_val[0] == "/c":
            if len(args_val) > 1:
                config_data["command"] = args_val[1]
                config_data["args"] = args_val[2:]

    # Inject authorization headers if connecting to Zapier MCP
    headers = {}
    mcp_url_str = mcp_url
    if config_data and isinstance(config_data, dict):
        mcp_url_str = config_data.get("url") or mcp_url or ""

    # Strip hash fragment from URL to get the base endpoint
    base_url = mcp_url_str.split("#")[0]

    is_zapier = base_url.startswith("https://mcp.zapier.com/")
    if is_zapier:
        from research_agent.tools.provider_engine import get_user_api_key
        zapier_secret = get_user_api_key("zapier_mcp_secret")
        if zapier_secret:
            headers["Authorization"] = f"Bearer {zapier_secret}"

    # Merge custom headers from JSON configuration (e.g. for remote authenticated MCPs like Apify)
    if config_data and isinstance(config_data, dict):
        custom_headers = config_data.get("headers")
        if isinstance(custom_headers, dict):
            for k, v in custom_headers.items():
                headers[str(k)] = str(v)

    # --- Stateless POST Interceptor ---
    if base_url.startswith("http://") or base_url.startswith("https://"):
        try:
            import httpx
            logger.info(f"Checking if URL is stateless/POST endpoint: {base_url}")
            
            post_headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                **headers
            }
            
            async def _check_stateless():
                async with httpx.AsyncClient(timeout=8.0) as client:
                    resp = await client.post(
                        base_url,
                        headers=post_headers,
                        json={
                            "jsonrpc": "2.0",
                            "method": "tools/list",
                            "params": {},
                            "id": 1
                        }
                    )
                    if resp.status_code != 200:
                        return None
                    text = resp.text
                    # Try 1: plain JSON (stateless HTTP mode)
                    try:
                        data = json.loads(text)
                        if "result" in data and "tools" in data["result"]:
                            return data
                    except Exception:
                        pass
                    # Try 2: SSE-encoded JSON (Smithery Remote returns SSE even for stateless POST)
                    # Format: "event: message\ndata: {"jsonrpc":"2.0","result":{"tools":[...]},"id":1}"
                    for line in text.split("\n"):
                        if line.startswith("data:"):
                            payload = line[5:].strip()
                            if not payload:
                                continue
                            try:
                                data = json.loads(payload)
                                if "result" in data and "tools" in data["result"]:
                                    return data
                            except Exception:
                                pass
                    return None
            
            list_res = await _check_stateless()
            if list_res and "result" in list_res and "tools" in list_res["result"]:
                logger.info(f"Target {base_url} verified as stateless. Loading all tools via stateless adapter into cache.")
                raw_tools = list_res["result"]["tools"]
                
                from pydantic import create_model, Field
                from typing import Optional, Union
                from langchain_core.tools import StructuredTool
                
                type_mapping = {
                    "string": str,
                    "integer": int,
                    "number": float,
                    "boolean": bool,
                    "array": list,
                    "object": dict
                }
                
                parsed_tools = []
                for tool_data in raw_tools:
                    tool_name = tool_data.get("name")
                    description = tool_data.get("description", "")
                    
                    input_schema = tool_data.get("inputSchema", {})
                    properties = input_schema.get("properties", {})
                    required = input_schema.get("required", [])
                    
                    fields = {}
                    for param_name, param_schema in properties.items():
                        js_type = param_schema.get("type", "string")
                        py_type = Any
                        is_optional = False
                        
                        if isinstance(js_type, list):
                            if "null" in js_type:
                                is_optional = True
                            actual_types = [t for t in js_type if t != "null"]
                            if actual_types:
                                py_type = type_mapping.get(actual_types[0], Any)
                        else:
                            py_type = type_mapping.get(js_type, Any)
                            
                        param_desc = param_schema.get("description", "")
                        default_val = param_schema.get("default")
                        
                        if param_name in required:
                            if is_optional:
                                fields[param_name] = (Optional[py_type], Field(description=param_desc))
                            else:
                                fields[param_name] = (py_type, Field(description=param_desc))
                        else:
                            fields[param_name] = (Optional[py_type], Field(default=default_val, description=param_desc))
                            
                    args_schema = create_model(f"{tool_name}Input", **fields)
                    
                    def make_execute_fn(t_name):
                        async def _execute(**kwargs):
                            args_payload = {k: v for k, v in kwargs.items() if v is not None}
                            exec_headers = {
                                "Content-Type": "application/json",
                                "Accept": "application/json, text/event-stream",
                                **headers
                            }
                            async with httpx.AsyncClient(timeout=60.0) as exec_client:
                                exec_resp = await exec_client.post(
                                    base_url,
                                    headers=exec_headers,
                                    json={
                                        "jsonrpc": "2.0",
                                        "method": "tools/call",
                                        "params": {
                                            "name": t_name,
                                            "arguments": args_payload
                                        },
                                        "id": 1
                                    }
                                )
                                exec_resp.raise_for_status()
                                text = exec_resp.text
                                exec_data = None
                                
                                try:
                                    exec_data = json.loads(text)
                                except Exception:
                                    pass
                                    
                                if exec_data is None:
                                    for line in text.split("\n"):
                                        if line.startswith("data:"):
                                            payload = line[5:].strip()
                                            if not payload:
                                                continue
                                            try:
                                                parsed = json.loads(payload)
                                                if "result" in parsed or "error" in parsed:
                                                    exec_data = parsed
                                                    break
                                            except Exception:
                                                pass
                                                
                                if exec_data is None:
                                    exec_data = exec_resp.json()
                                    
                                if "error" in exec_data:
                                    return f"Error executing tool: {exec_data['error']}"
                                    
                                result = exec_data.get("result", {})
                                content = result.get("content", [])
                                text_parts = []
                                for item in content:
                                    if isinstance(item, dict):
                                        if item.get("type") == "text":
                                            text_parts.append(item.get("text", ""))
                                        else:
                                            text_parts.append(json.dumps(item))
                                    else:
                                        text_parts.append(str(item))
                                return "\n".join(text_parts)
                        return _execute

                    stateless_tool = StructuredTool(
                        name=tool_name,
                        description=description,
                        args_schema=args_schema,
                        func=None,
                        coroutine=make_execute_fn(tool_name)
                    )
                    parsed_tools.append(wrap_tool_with_redaction(stateless_tool))
                
                _manual_mcp_tools_cache[cache_key] = parsed_tools
                matched = [t for t in parsed_tools if t.name == tool_key]
                if matched:
                    return [matched[0]]
                else:
                    logger.warning(f"Tool '{tool_key}' not found in stateless server's tool listing.")
                    return []
        except Exception as stateless_err:
            logger.info(f"Stateless verification failed for {base_url}: {stateless_err}. Falling back to stateful adapter...")

    # Setup safe environment for Stdio subprocess sandboxing
    safe_env = None

    # Setup session_kwargs to enable sampling capability callback
    session_kwargs = {
        "sampling_callback": lambda ctx, params: handle_sampling_request(ctx, params, server_name=tool_key),
        "sampling_capabilities": mcp.types.SamplingCapability()
    }

    if config_data and isinstance(config_data, dict):
        transport = config_data.get("transport", "sse")
        if transport == "stdio":
            try:
                from blockbuster.blockbuster import blockbuster_skip
                skip_token = blockbuster_skip.set(True)
            except Exception:
                skip_token = None

            try:
                safe_env = _build_safe_env(config_data.get("env", {}))
                cmd_val = config_data.get("command")
                args_val = config_data.get("args") or []
                
                # Wrap node stdio servers with mcp-wrapper.cjs to filter out non-JSON stdout banners
                if cmd_val == "node" and len(args_val) > 0 and args_val[0].endswith(".js") and not any("mcp-wrapper.cjs" in str(a) for a in args_val):
                    wrapper_path = "mcp-wrapper.cjs"
                    if not os.path.exists(wrapper_path):
                        alt_path = os.path.join("deep-agents-ui-main", "mcp-wrapper.cjs")
                        if os.path.exists(alt_path):
                            wrapper_path = alt_path
                    args_val = [wrapper_path] + args_val
                
                # Resolve bare commands under restricted PATH and inject binary directory
                cmd_val, safe_env = _resolve_stdio_command(cmd_val, safe_env)
            finally:
                if skip_token is not None:
                    try:
                        blockbuster_skip.reset(skip_token)
                    except Exception:
                        pass
                
            server_config = {
                "manual_server": {
                    "transport": "stdio",
                    "command": cmd_val,
                    "args": args_val,
                    "env": safe_env,
                    "session_kwargs": session_kwargs,
                }
            }
        else:
            server_config = {
                "manual_server": {
                    "transport": "streamable-http" if is_zapier else transport,
                    "url": config_data.get("url", base_url),
                    "headers": headers,
                    "session_kwargs": session_kwargs,
                }
            }
    else:
        server_config = {
            "manual_server": {
                "transport": "streamable-http" if is_zapier else "sse",
                "url": base_url,
                "headers": headers,
                "session_kwargs": session_kwargs,
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

    # Determine if this is a stdio transport — if so, we need to bypass blockbuster's
    # os.access patch which fires when the MCP SDK calls shutil.which() to locate the
    # subprocess command (e.g. "npx"). We do this by running the entire session in a
    # dedicated thread that uses the real os.access.
    _server_cfg = server_config.get("manual_server", {})
    _is_stdio = _server_cfg.get("transport") == "stdio"

    async def _run_session() -> List[BaseTool]:
        """List tools via a temporary session, then create connection-aware tool objects.

        Using connection= (not session=) is critical: tools created with session= hold
        a reference to the session that is already closed once the async context exits,
        so every subsequent ainvoke raises an empty exception. With connection=, each
        ainvoke opens a fresh session on demand.
        """
        from langchain_mcp_adapters.tools import convert_mcp_tool_to_langchain_tool
        from langchain_mcp_adapters.tools import _list_all_tools

        # Step 1: use a temporary session ONLY to list available tool definitions
        try:
            async def _get_tools():
                async with client.session("manual_server") as session:
                    return await _list_all_tools(session)
            raw_tools = await asyncio.wait_for(_get_tools(), timeout=5.0)
        except Exception as conn_err:
            logger.warning(f"Failed to connect to manual MCP server within 5s: {conn_err}")
            return []

        # Step 2: build tool objects bound to the connection config for all tools
        converted = [
            convert_mcp_tool_to_langchain_tool(
                None,
                t,
                connection=_server_cfg,
            )
            for t in raw_tools
        ]

        wrapped = [wrap_tool_with_redaction(t) for t in converted]
        _manual_mcp_tools_cache[cache_key] = wrapped
        logger.info(f"Loaded {len(wrapped)} manual MCP tools from server into cache")

        matched = [t for t in wrapped if t.name == tool_key]
        if not matched:
            logger.warning(
                f"Manual MCP tool '{tool_key}' not found on server. "
                f"Available: {[t.name for t in raw_tools]}"
            )
            return []
        return [matched[0]]

    if _is_stdio:
        # For stdio transport the MCP SDK calls shutil.which() → os.access() which
        # blockbuster has monkey-patched globally.  blockbuster's wrapper checks the
        # ContextVar `blockbuster_skip`; when it is True the real function is called
        # immediately.  We set it in the worker thread so every os.access / stat call
        # inside the MCP session is allowed.
        def _run_in_isolated_thread() -> List[BaseTool]:
            # Import blockbuster's skip ContextVar and set it for this thread's context
            try:
                from blockbuster.blockbuster import blockbuster_skip
                skip_token = blockbuster_skip.set(True)
            except Exception:
                skip_token = None

            new_loop = asyncio.new_event_loop()
            try:
                return new_loop.run_until_complete(_run_session())
            finally:
                new_loop.close()
                # Reset the ContextVar after we are done
                if skip_token is not None:
                    try:
                        blockbuster_skip.reset(skip_token)
                    except Exception:
                        pass

        try:
            tools = await asyncio.to_thread(_run_in_isolated_thread)
            return tools
        except Exception as e:
            logger.error(f"Error loading manual MCP tool {tool_key} from {server_config}: {e}")
            try:
                with open("agent_load.log", "a", encoding="utf-8") as f:
                    import traceback
                    f.write(f"\n--- Error loading manual MCP tool '{tool_key}' ---\n")
                    f.write(traceback.format_exc())
                    f.write("-" * 40 + "\n")
            except Exception:
                pass
            return []
    else:
        # For SSE/streamable-http: no shutil.which call, proceed normally
        try:
            return await _run_session()
        except Exception as e:
            logger.error(f"Error loading manual MCP tool {tool_key} from {server_config}: {e}")
            try:
                with open("agent_load.log", "a", encoding="utf-8") as f:
                    import traceback
                    f.write(f"\n--- Error loading manual MCP tool '{tool_key}' ---\n")
                    f.write(traceback.format_exc())
                    f.write("-" * 40 + "\n")
            except Exception:
                pass
            return []


def load_mcp_tools_for_agent(agent_id: str) -> List[BaseTool]:
    """Fetch assigned MCP tools for an agent from Supabase and initialize them."""
    try:
        from supabase import create_client
    except ImportError:
        logger.warning("supabase package not installed. Cannot load MCP tools.")
        return []

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        logger.warning("SUPABASE_URL or SUPABASE_ANON_KEY not set. Cannot load MCP tools.")
        return []

    try:
        client = create_client(url, key)
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client in mcp_loader: {e}")
        return []

    # Call get_backend_bootstrap_data RPC to bypass RLS
    try:
        bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
        bootstrap = bootstrap_resp.data or {}
    except Exception as e:
        logger.error(f"Failed to fetch bootstrap data in load_mcp_tools_for_agent: {e}")
        bootstrap = {}

    # Get enabled MCP tool assignments for this agent
    all_assignments = bootstrap.get("agent_tool_assignments") or []
    assignments = [a for a in all_assignments if a.get("agent_id") == agent_id and a.get("tool_type") == "mcp" and a.get("enabled") == True]
    if not assignments:
        return []

    # Resolve user_id from agent_configs
    all_configs = bootstrap.get("agent_configs") or []
    agent_cfg = next((c for c in all_configs if c.get("id") == agent_id), None)
    user_id = agent_cfg.get("user_id") if agent_cfg else None

    # Filter settings by user_id
    all_settings = bootstrap.get("agent_settings") or []
    db_settings = {}
    for row in all_settings:
        row_uid = row.get("user_id")
        if user_id:
            if row_uid == user_id or not row_uid:
                db_settings[row["key"]] = row["value"]
        else:
            if not row_uid:
                db_settings[row["key"]] = row["value"]

    super_enabled = db_settings.get("super_indexing_enabled", "true").lower() == "true"
    normal_enabled = db_settings.get("normal_indexing_enabled", "true").lower() == "true"

    # Fetch global MCP tool settings
    all_mcp_settings = bootstrap.get("mcp_tool_settings") or []
    mcp_tool_modes = {row["tool_key"]: row["loading_mode"] for row in all_mcp_settings}

    # Only load tools with loading_mode == 'primary' (after global resolution and overrides)
    primary_assignments = []
    for a in assignments:
        tool_key = a.get("tool_key")
        # Resolve global loading mode
        mode = a.get("loading_mode")
        if not mode:
            mode = mcp_tool_modes.get(tool_key, "primary")
        if tool_key in ["list_tools", "load_tools", "call_tool"]:
            mode = "primary"
            
        # Map legacy vector to super
        if mode == "vector":
            mode = "super"

        # Apply override if disabled
        if mode == "super" and not super_enabled:
            mode = "primary"
        if mode == "normal" and not normal_enabled:
            mode = "primary"
            
        if mode == "primary":
            primary_assignments.append(a)

    assigned_keys = {a["tool_key"] for a in primary_assignments}
    logger.info(f"Loading {len(assigned_keys)} MCP tools for agent {agent_id}: {assigned_keys}")

    # Fetch active MCP connections from bootstrap
    all_connections = bootstrap.get("mcp_connections") or []
    connections = []
    for conn in all_connections:
        conn_uid = conn.get("user_id")
        if user_id:
            if conn_uid == user_id or not conn_uid:
                connections.append(conn)
        else:
            if not conn_uid:
                connections.append(conn)

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
        composio_api_key = None
        user_email = ""
        if user_id:
            try:
                settings_resp = client.table("agent_settings").select("value").eq("user_id", user_id).eq("key", "composio_api_key").maybe_single().execute()
                if settings_resp.data:
                    composio_api_key = settings_resp.data.get("value")
            except Exception as e:
                logger.error(f"Failed to fetch user Composio API key from agent_settings: {e}")

            if not composio_api_key:
                try:
                    email_setting = client.table("agent_settings").select("value").eq("user_id", user_id).eq("key", "user_email").maybe_single().execute()
                    if email_setting.data:
                        user_email = email_setting.data.get("value", "")
                except Exception:
                    pass

        if not composio_api_key:
            composio_api_key = os.environ.get("COMPOSIO_API_KEY", "")
            
        if composio_api_key:
            try:
                from composio import Composio
                from composio_langchain import LangchainProvider
                composio = Composio(api_key=composio_api_key, provider=LangchainProvider())
                active_user_id = user_id or "default"
                comp_tools = composio.tools.get(user_id=active_user_id, tools=composio_keys)
                loaded_tools.extend(comp_tools)
                logger.info(f"Loaded {len(comp_tools)} Composio tools")
                try:
                    log_path = os.path.join(tempfile.gettempdir(), "agent_load.log")
                    with open(log_path, "a", encoding="utf-8") as f:
                        f.write(f"[mcp_loader] Loaded {len(comp_tools)} Composio tools for agent {agent_id}: {[t.name for t in comp_tools]}\n")
                except Exception:
                    pass
            except Exception as e:
                logger.warning(f"Failed to load Composio tools: {e}")
                try:
                    log_path = os.path.join(tempfile.gettempdir(), "agent_load.log")
                    with open(log_path, "a", encoding="utf-8") as f:
                        import traceback
                        f.write(f"[mcp_loader] Failed to load Composio tools for agent {agent_id}: {e}\n{traceback.format_exc()}\n")
                except Exception:
                    pass
        else:
            logger.warning("COMPOSIO_API_KEY not set. Skipping Composio tools.")
            try:
                log_path = os.path.join(tempfile.gettempdir(), "agent_load.log")
                with open(log_path, "a", encoding="utf-8") as f:
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
