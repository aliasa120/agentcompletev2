"""Tool for re-analyzing previous message attachments (audio, video, PDFs) in follow-up queries.

Retrieves the media URL from Supabase, checks if the model supports it natively,
and runs Omni fallback if the active model is text-only.
"""

import os
import uuid
import re
import requests
from typing import Optional
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from research_agent.tools.provider_engine import (
    get_llm_config,
    get_settings,
    get_provider_base_url,
    get_provider_api_key,
    get_provider_config,
    get_all_provider_names
)

@tool(parse_docstring=True)
def analyze_attachment(filename: str, query: str, config: RunnableConfig) -> str:
    """Intelligently inspect and re-analyze a previously uploaded file (audio, video, PDF) to answer a follow-up query.

    Use this tool if the user asks a follow-up question about a file they already uploaded,
    and you need to inspect the file again (e.g. asking for specific timestamp details, transcript double-checks, etc.).

    Args:
        filename: The exact name of the file to inspect (e.g. 'interview.mp3', 'screencast.mp4', 'document.pdf').
        query: The specific question or action to perform on the media file (e.g. 'What was said at 2:30?').

    Returns:
        The analysis result from the file, or a request to upload again if expired.
    """
    print(f"[analyze_attachment] Tool called for file: {filename}, query: {query}")
    lower_filename = filename.lower()

    from research_agent.tools.provider_engine import active_user_id
    configurable = config.get("configurable", {})
    user_id = configurable.get("user_id")
    if user_id:
        active_user_id.set(user_id)

    thread_id = configurable.get("thread_id")
    
    if not thread_id:
        return "❌ Error: Thread ID is missing in configuration."

    try:
        session_uuid = str(uuid.UUID(thread_id))
    except ValueError:
        session_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, thread_id))

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.environ.get("SUPABASE_ANON_KEY", "")
    
    if not supabase_url or not supabase_key:
        return "❌ Error: Supabase database configuration missing on backend."

    # 1. Fetch thread history from Supabase to find the file URL
    file_url = None
    try:
        from supabase import create_client, ClientOptions
        opts = ClientOptions(postgrest_client_timeout=300, storage_client_timeout=300)
        client = create_client(supabase_url, supabase_key, options=opts)
        res = client.table("messages").select("content").eq("session_id", session_uuid).execute()
        messages_data = res.data or []
        
        # Search messages for the filename and capture its Supabase URL
        for msg in messages_data:
            content = msg.get("content", "")
            if filename in content:
                # Find matching Supabase storage URL
                urls = re.findall(r'https://[a-zA-Z0-9\-\.]+\.supabase\.co/storage/v1/object/public/uploads/[a-zA-Z0-9\-\._%]+', content)
                for u in urls:
                    if filename.lower() in u.lower() or filename.split(".")[0].lower() in u.lower():
                        file_url = u
                        break
            if file_url:
                break
    except Exception as db_err:
        print(f"[analyze_attachment] DB lookup failed: {db_err}")
        return f"❌ Error: Database error looking up attachment '{filename}'."

    if not file_url:
        return f"❌ Error: Could not find any uploaded file named '{filename}' in this chat history."

    # 2. Expiration Check (HTTP HEAD request to verify file still exists)
    try:
        head_resp = requests.head(file_url, timeout=5.0)
        if head_resp.status_code == 404:
            return f"❌ Error: The file '{filename}' has expired (retention limit: 24 hours). Please ask the user to upload the file again."
    except Exception as head_err:
        print(f"[analyze_attachment] Expiration head check failed: {head_err}")
        return f"❌ Error: Unable to access the file '{filename}' (it may have expired). Please ask the user to upload it again."

    # 3. Call Omni Fallback to process the media with the user's specific query
    from research_agent.tools.provider_engine import _fetch_settings_from_supabase, get_settings
    settings = _fetch_settings_from_supabase(user_id) or get_settings(user_id)
    omni_provider = settings.get("omni_provider", "gemini").strip().lower()
    omni_model = settings.get("omni_model", "gemini-3.1-flash-lite").strip()

    # Download the file content and resolve mime-type
    import base64
    import mimetypes
    
    raw_bytes = b""
    base64_data = ""
    mime_type = ""
    try:
        print(f"[analyze_attachment] Downloading file content: {file_url}")
        file_resp = requests.get(file_url, timeout=30.0)
        file_resp.raise_for_status()
        raw_bytes = file_resp.content
        base64_data = base64.b64encode(raw_bytes).decode("utf-8")
        
        # Resolve mime-type
        mime_type = file_resp.headers.get("content-type", "")
        if not mime_type:
            mime_type, _ = mimetypes.guess_type(lower_filename)
        if not mime_type:
            mime_type = "application/octet-stream"
    except Exception as download_err:
        print(f"[analyze_attachment] Failed to download/encode file: {download_err}")
        return f"❌ Error: Failed to download the file '{filename}' from storage. Detail: {download_err}"

    # Text instruction & query
    instruction = (
        f"You are analyzing the previously uploaded file: {filename}\n"
        f"Public File URL: {file_url}\n"
        f"User Query: {query}\n\n"
        f"Please analyze the file and answer the user's query precisely."
    )

    if omni_provider == "gemini":
        from research_agent.tools.provider_engine import get_user_api_key
        gemini_key = get_user_api_key("gemini_client_api_key", user_id=user_id)
        if not gemini_key:
            return "❌ Error: gemini_client_api_key is not set in user settings."
        
        try:
            from google import genai
            from google.genai import types
            
            print(f"[analyze_attachment] Running Direct Gemini Omni analysis on {filename} with model {omni_model}...")
            client = genai.Client(api_key=gemini_key)
            
            model_id = omni_model
            if "/" in model_id:
                model_id = model_id.split("/")[-1]
                
            contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=instruction),
                        types.Part.from_bytes(data=raw_bytes, mime_type=mime_type)
                    ]
                )
            ]
            response = client.models.generate_content(
                model=model_id,
                contents=contents
            )
            print(f"[analyze_attachment] Direct Gemini analysis completed successfully.")
            return response.text.strip()
        except Exception as gemini_err:
            print(f"[analyze_attachment] Direct Gemini call failed: {gemini_err}")
            return f"❌ Error: Gemini Omni analysis failed: {gemini_err}"

    else:
        # Resolve api_key & base_url for omni_provider
        actual_provider = omni_provider
        if actual_provider not in get_all_provider_names():
            actual_provider = "openrouter"
            
        gateway_base = get_provider_base_url(actual_provider)
        cfg = get_provider_config(actual_provider)
        needs_v1 = cfg and "base_url_env" in cfg
        if needs_v1 and not gateway_base.endswith("/v1"):
            gateway_base = gateway_base + "/v1"
            
        from research_agent.tools.provider_engine import get_user_api_key
        agent_settings_key = cfg.get("agent_settings_key", "") if cfg else ""
        if agent_settings_key:
            api_key = get_user_api_key(agent_settings_key, user_id=user_id)
        else:
            api_key = ""
            
        if not api_key:
            return f"❌ Error: API key config missing in user settings for provider '{actual_provider}'."

        # Build multimodal content parts
        content_parts = []
        content_parts.append({"type": "text", "text": instruction})

        # File attachment content mapping
        if lower_filename.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{base64_data}"}
            })
        elif lower_filename.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")):
            content_parts.append({
                "type": "input_audio",
                "input_audio": {
                    "data": base64_data,
                    "format": "mp3" if "mp3" in lower_filename else "wav"
                }
            })
        else:
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{base64_data}"}
            })

        payload = {
            "model": omni_model,
            "messages": [{"role": "user", "content": content_parts}],
            "temperature": 0.2,
            "max_tokens": 2048,
        }

        try:
            print(f"[analyze_attachment] Running Omni fallback on {filename} via {omni_provider} with model {omni_model}...")
            resp = requests.post(
                f"{gateway_base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=90,
            )
            resp.raise_for_status()
            raw_response = resp.json()["choices"][0]["message"]["content"].strip()
            print(f"[analyze_attachment] Omni analysis completed successfully.")
            return raw_response
        except Exception as llm_err:
            print(f"[analyze_attachment] LLM analysis call failed: {llm_err}")
            return f"❌ Error: Failed to analyze the attachment '{filename}' using fallback LLM. Detail: {llm_err}"
