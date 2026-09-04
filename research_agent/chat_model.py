"""ResilientChatModel — Enterprise rate-limit-aware LLM wrapper with dynamic configuration,
reasoning token preservation, memory injection, and reactive multimodal fallback.

Multimodal strategy (two tiers, no proactive capability routing):
1. Encode attachments as base64 and send them inline with the message to the
   selected model directly.
2. If the provider rejects the payload (e.g. 400 "image not supported"), retry
   the same request through the Omni transduction layer, which converts the
   attachment into structured text notes.
"""

import os
import time
import random
import asyncio
from typing import Optional, Any
from pydantic import SecretStr

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

# Monkeypatch langchain_openai._convert_delta_to_message_chunk to preserve reasoning_content
try:
    import langchain_openai.chat_models.base as langchain_openai_base
    original_convert = langchain_openai_base._convert_delta_to_message_chunk

    def custom_convert_delta_to_message_chunk(_dict, default_class):
        chunk = original_convert(_dict, default_class)
        reasoning_content = _dict.get("reasoning_content") or _dict.get("reasoning")
        if reasoning_content:
            chunk.additional_kwargs["reasoning_content"] = reasoning_content
        return chunk

    langchain_openai_base._convert_delta_to_message_chunk = custom_convert_delta_to_message_chunk
except Exception as e:
    print(f"[ResilientChatModel] Warning: Failed to apply reasoning monkeypatch: {e}")

# Rate-limit and retry configurations
_LLM_MAX_ATTEMPTS = 6          # total attempts before giving up
_LLM_RATE_LIMIT_DELAY = 65.0   # flat wait (s) after a 429
_LLM_BASE_DELAY = 5.0          # base delay for other errors (exponential backoff)


class WrappedSyncStream:
    def __init__(self, original_stream, generator):
        self.original_stream = original_stream
        self.generator = generator

    def __enter__(self):
        if hasattr(self.original_stream, "__enter__"):
            self.original_stream.__enter__()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if hasattr(self.original_stream, "__exit__"):
            self.original_stream.__exit__(exc_type, exc_val, exc_tb)

    def __iter__(self):
        return self.generator


class WrappedAsyncStream:
    def __init__(self, original_stream, generator):
        self.original_stream = original_stream
        self.generator = generator

    async def __aenter__(self):
        if hasattr(self.original_stream, "__aenter__"):
            await self.original_stream.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if hasattr(self.original_stream, "__aexit__"):
            await self.original_stream.__aexit__(exc_type, exc_val, exc_tb)

    def __aiter__(self):
        return self.generator


async def _aheal_unsupported_media(kwargs: dict, user_id: str = None) -> dict:
    """Reactive healer for OpenAI chat completion kwargs when provider rejects media payload with 400."""
    import copy
    from research_agent.preflight import (
        get_extraction_prompts, run_omni_gemini_direct_async,
        run_omni_gateway_async, make_system_note,
        collect_attachment_url, append_attachment_links
    )
    from research_agent.tools.provider_engine import get_settings, active_user_id

    effective_user_id = user_id or active_user_id.get()
    db_settings = get_settings(effective_user_id)
    prompts = get_extraction_prompts(effective_user_id)
    omni_provider = db_settings.get("omni_provider", "gemini").strip().lower()
    omni_model = db_settings.get("omni_model", "gemini-3.1-flash-lite").strip()

    def _prompt_key_for_url(url: str) -> str:
        url_lower = url.lower()
        if url.startswith("data:application/pdf") or url_lower.endswith(".pdf"):
            return "document"
        if url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")):
            return "audio"
        if url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")):
            return "video"
        return "image"

    def _note_url(url: str) -> str:
        if url.startswith(("http://", "https://")):
            return url
        if url.startswith("data:"):
            mime = url.split(";")[0].replace("data:", "") if ";" in url else "unknown"
            return f"<inline {mime} attachment>"
        return url or "<attachment>"

    new_kwargs = copy.copy(kwargs)
    raw_messages = kwargs.get("messages", [])
    healed_messages = []

    for msg in raw_messages:
        if isinstance(msg, dict):
            content = msg.get("content")
            if not isinstance(content, list):
                healed_messages.append(msg)
                continue

            new_content = []
            attachment_links = []
            for block in content:
                collect_attachment_url(block, attachment_links)

            for block in content:
                if not isinstance(block, dict):
                    new_content.append(block)
                    continue
                block_type = block.get("type")
                if block_type == "text":
                    new_content.append(block)
                elif block_type == "image_url":
                    img_dict = block.get("image_url", {})
                    url = img_dict.get("url", "") if isinstance(img_dict, dict) else str(img_dict)
                    url = url or block.get("url", "")
                    prompt_key = _prompt_key_for_url(url)
                    try:
                        analysis = (
                            await run_omni_gemini_direct_async(prompts[prompt_key], block, effective_user_id)
                            if omni_provider == "gemini"
                            else await run_omni_gateway_async(prompts[prompt_key], block, effective_user_id)
                        )
                        note = make_system_note(block, _note_url(url), omni_model, analysis)
                        new_content.append(note if isinstance(note, dict) else {"type": "text", "text": str(note)})
                    except Exception as e:
                        new_content.append({"type": "text", "text": f"[Omni Analysis Failed for {url}: {e}]"})
                elif block_type in ("audio", "input_audio"):
                    url = block.get("audio", "") or block.get("input_audio", {}).get("data", "")
                    try:
                        analysis = (
                            await run_omni_gemini_direct_async(prompts["audio"], block, effective_user_id)
                            if omni_provider == "gemini"
                            else await run_omni_gateway_async(prompts["audio"], block, effective_user_id)
                        )
                        note = make_system_note(block, _note_url(url), omni_model, analysis)
                        new_content.append(note if isinstance(note, dict) else {"type": "text", "text": str(note)})
                    except Exception as e:
                        new_content.append({"type": "text", "text": f"[Omni Analysis Failed for audio: {e}]"})
                elif block_type == "video":
                    url = block.get("video", "")
                    try:
                        analysis = (
                            await run_omni_gemini_direct_async(prompts["video"], block, effective_user_id)
                            if omni_provider == "gemini"
                            else await run_omni_gateway_async(prompts["video"], block, effective_user_id)
                        )
                        note = make_system_note(block, _note_url(url), omni_model, analysis)
                        new_content.append(note if isinstance(note, dict) else {"type": "text", "text": str(note)})
                    except Exception as e:
                        new_content.append({"type": "text", "text": f"[Omni Analysis Failed for video: {e}]"})
                else:
                    new_content.append(block)

            append_attachment_links(new_content, attachment_links)

            text_parts = []
            for b in new_content:
                if isinstance(b, str):
                    text_parts.append(b)
                elif isinstance(b, dict):
                    if b.get("type") == "text":
                        text_parts.append(b.get("text", ""))
                    elif "text" in b:
                        text_parts.append(str(b["text"]))

            new_msg = copy.copy(msg)
            new_msg["content"] = "\n\n".join(text_parts) if text_parts else ""
            healed_messages.append(new_msg)
        else:
            healed_messages.append(msg)

    new_kwargs["messages"] = healed_messages
    return new_kwargs


def _heal_unsupported_media_sync(kwargs: dict, user_id: str = None) -> dict:
    """Sync fallback for reactive healing of media payloads."""
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(asyncio.run, _aheal_unsupported_media(kwargs, user_id)).result()


class ResilientChatModel(ChatOpenAI):
    """Wraps ChatOpenAI with rate-limit-aware retries tuned for enterprise LLM APIs."""

    max_retries: int = 0  # Disable built-in tenacity retries — we handle it ourselves
    agent_type: str = "main_agent"
    agent_config_id: str = ""  # UUID from agent_configs table; when set, dynamic reload reads per-workflow settings
    is_omni_call: bool = False
    max_tokens: Optional[int] = 4096

    def _inject_memory_to_messages(self, messages: list) -> list:
        """Inject USER.md + MEMORY.md + Honcho context into the LAST HumanMessage without dropping multimodal blocks or user text."""
        try:
            from research_agent.tools.provider_engine import get_active_user_id, get_active_workflow_id, get_active_thread_id
            user_id = get_active_user_id() or getattr(self, "user_id", None)
            workflow_id = get_active_workflow_id() or getattr(self, "workflow_id", None)
            thread_id = get_active_thread_id() or getattr(self, "thread_id", None) or ""
            if not user_id:
                return messages

            last_human_idx = -1
            user_msg = ""
            for idx, m in enumerate(messages):
                role = getattr(m, "type", None) or (m.get("role") if isinstance(m, dict) else None)
                if role in ("human", "user"):
                    last_human_idx = idx
                    content = m.content if hasattr(m, "content") else (m.get("content", "") if isinstance(m, dict) else "")
                    if isinstance(content, str):
                        user_msg = content[:500]
                    elif isinstance(content, list):
                        text_parts = []
                        for b in content:
                            if isinstance(b, str):
                                text_parts.append(b)
                            elif isinstance(b, dict) and b.get("type") == "text":
                                text_parts.append(b.get("text", ""))
                        user_msg = " ".join(text_parts)[:500]

            if last_human_idx < 0:
                return messages

            import concurrent.futures
            from research_agent.memory.memory_manager import get_memory_manager
            mm = get_memory_manager()

            def _build_block_in_thread():
                from research_agent.tools.provider_engine import active_user_id as _thr_uid, active_workflow_id as _thr_wfid, active_thread_id as _thr_tid
                _t1 = _thr_uid.set(user_id) if user_id else None
                _t2 = _thr_wfid.set(workflow_id) if workflow_id else None
                _t3 = _thr_tid.set(thread_id) if thread_id else None
                try:
                    return mm.build_system_prompt_context(
                        user_id=user_id,
                        workflow_id=workflow_id or "default_workflow",
                        user_message=user_msg,
                        thread_id=thread_id,
                    )
                finally:
                    if _t1 is not None: _thr_uid.reset(_t1)
                    if _t2 is not None: _thr_wfid.reset(_t2)
                    if _t3 is not None: _thr_tid.reset(_t3)

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                context_block = ex.submit(_build_block_in_thread).result()

            if not context_block:
                return messages

            new_messages = list(messages)
            target = new_messages[last_human_idx]

            if hasattr(target, "content"):
                orig = target.content
                if isinstance(orig, str):
                    if "<memory-context>" not in orig:
                        new_content = f"{orig}\n\n{context_block}"
                        if hasattr(target, "model_copy"):
                            new_messages[last_human_idx] = target.model_copy(update={"content": new_content})
                        elif hasattr(target, "copy"):
                            new_messages[last_human_idx] = target.copy(update={"content": new_content})
                        else:
                            new_messages[last_human_idx] = HumanMessage(content=new_content, additional_kwargs=getattr(target, "additional_kwargs", {}))
                elif isinstance(orig, list):
                    has_mem = any(
                        ("<memory-context>" in (b if isinstance(b, str) else b.get("text", "")))
                        for b in orig if isinstance(b, (str, dict))
                    )
                    if not has_mem:
                        new_blocks = list(orig) + [{"type": "text", "text": f"\n\n{context_block}"}]
                        if hasattr(target, "model_copy"):
                            new_messages[last_human_idx] = target.model_copy(update={"content": new_blocks})
                        elif hasattr(target, "copy"):
                            new_messages[last_human_idx] = target.copy(update={"content": new_blocks})
                        else:
                            new_messages[last_human_idx] = HumanMessage(content=new_blocks, additional_kwargs=getattr(target, "additional_kwargs", {}))
            elif isinstance(target, dict):
                orig = target.get("content", "")
                if isinstance(orig, str):
                    if "<memory-context>" not in orig:
                        new_messages[last_human_idx] = dict(target, content=f"{orig}\n\n{context_block}")
                elif isinstance(orig, list):
                    has_mem = any(
                        ("<memory-context>" in (b if isinstance(b, str) else b.get("text", "")))
                        for b in orig if isinstance(b, (str, dict))
                    )
                    if not has_mem:
                        new_messages[last_human_idx] = dict(target, content=list(orig) + [{"type": "text", "text": f"\n\n{context_block}"}])
            return new_messages
        except Exception as e:
            import traceback
            print(f"[ResilientChatModel] Memory injection error: {e}")
            traceback.print_exc()
            return messages

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        messages = self._inject_memory_to_messages(messages)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        messages = self._inject_memory_to_messages(messages)
        return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        messages = self._inject_memory_to_messages(messages)
        async for chunk in super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs):
            yield chunk

    def _set_active_user_from_config(self, *args, **kwargs):
        config = kwargs.get("config")
        if not config:
            for arg in args:
                if isinstance(arg, dict) and ("configurable" in arg or "metadata" in arg):
                    config = arg
                    break

        user_id = None
        workflow_id = None
        thread_id = None
        if config and isinstance(config, dict):
            configurable = config.get("configurable", {})
            metadata = config.get("metadata", {})
            user_id = configurable.get("user_id") or metadata.get("user_id")
            workflow_id = configurable.get("workflow_id") or metadata.get("workflow_id")
            thread_id = configurable.get("thread_id") or configurable.get("session_id") or metadata.get("thread_id")

        from research_agent.tools.provider_engine import set_active_user_and_workflow
        set_active_user_and_workflow(user_id, workflow_id, thread_id)
        if user_id:
            object.__setattr__(self, "user_id", user_id)
        if workflow_id:
            object.__setattr__(self, "workflow_id", workflow_id)
        if thread_id:
            object.__setattr__(self, "thread_id", thread_id)

    def _resolve_dynamic_fields(self):
        """Dynamic resolution of settings from Supabase (per-workflow agent_configs or global agent_settings)."""
        if getattr(self, "is_omni_call", False):
            return
        try:
            import concurrent.futures
            from research_agent.tools.provider_engine import active_user_id as _active_uid

            captured_user_id = getattr(self, "user_id", None) or _active_uid.get()

            def _blocking_resolve():
                from research_agent.tools.provider_engine import active_user_id as _thr_uid
                _token = _thr_uid.set(captured_user_id) if captured_user_id else None
                try:
                    if self.agent_config_id:
                        return self._get_llm_config_from_agent_configs()
                    else:
                        from research_agent.tools.provider_engine import invalidate_settings_cache, get_llm_config
                        invalidate_settings_cache(captured_user_id)
                        return get_llm_config(self.agent_type, user_id=captured_user_id)
                finally:
                    if _token is not None:
                        _thr_uid.reset(_token)

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_blocking_resolve)
                base_url, api_key, model_name = future.result()

            current_model = getattr(self, "model_name", None) or getattr(self, "model", "")
            current_base_url = getattr(self, "openai_api_base", None) or getattr(self, "base_url", "")
            current_api_key = getattr(self, "openai_api_key", None) or getattr(self, "api_key", "")

            if current_model != model_name or current_base_url != base_url or current_api_key != api_key:
                print(f"[ResilientChatModel] [CHANGE] Settings changed for '{self.agent_type}'!")
                print(f"  Old model: {current_model} -> New model: {model_name}")
                print(f"  Old base_url: {current_base_url} -> New base_url: {base_url}")

                try:
                    object.__setattr__(self, "model_name", model_name)
                except Exception:
                    pass

                try:
                    object.__setattr__(self, "openai_api_base", base_url)
                except Exception:
                    pass

                if hasattr(self, "base_url"):
                    try:
                        object.__setattr__(self, "base_url", base_url)
                    except Exception:
                        pass

                try:
                    object.__setattr__(self, "openai_api_key", SecretStr(api_key) if api_key is not None else None)
                except Exception:
                    pass

                for attr in ["client", "async_client", "_client", "_async_client", "root_client", "root_async_client"]:
                    if hasattr(self, attr):
                        try:
                            object.__setattr__(self, attr, None)
                        except Exception:
                            pass

                self.validate_environment()
        except Exception as e:
            print(f"[ResilientChatModel] Error resolving dynamic settings: {e}")

    def validate_environment(self):
        current_api_key = getattr(self, "openai_api_key", None) or getattr(self, "api_key", None)
        has_env_key = bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENAI_ADMIN_KEY"))

        if not current_api_key and not has_env_key:
            object.__setattr__(self, "openai_api_key", SecretStr("dummy_key"))
            if hasattr(self, "api_key"):
                object.__setattr__(self, "api_key", "dummy_key")

        try:
            res = super().validate_environment()
        except Exception as e:
            if "api_key" in str(e) or "credentials" in str(e) or "ApiKey" in str(e) or "credentials" in str(e).lower():
                import openai
                object.__setattr__(self, "openai_api_key", SecretStr("dummy_key"))
                if hasattr(self, "api_key"):
                    object.__setattr__(self, "api_key", "dummy_key")
                self.root_client = openai.OpenAI(api_key="dummy_key")
                self.root_async_client = openai.AsyncOpenAI(api_key="dummy_key")
                res = self
            else:
                raise e

        for attr in ["client", "root_client"]:
            client_obj = getattr(self, attr, None)
            if client_obj and hasattr(client_obj, "chat") and hasattr(client_obj.chat, "completions"):
                original_create = client_obj.chat.completions.create

                if not getattr(original_create, "_is_wrapped_reasoning", False):
                    def wrapped_create_sync(*args, **kwargs):
                        base_url_str = getattr(self, "openai_api_base", "")
                        if "openrouter.ai" in base_url_str:
                            extra_body = kwargs.get("extra_body") or {}
                            extra_body["include_reasoning"] = True
                            kwargs["extra_body"] = extra_body

                        try:
                            response = original_create(*args, **kwargs)
                        except Exception as req_err:
                            err_str = str(req_err).lower()
                            # ── Reactive Fallback: Self-healing on 400 unsupported media type (Sync) ──
                            if "unsupported media type" in err_str or ("400" in err_str and any(w in err_str for w in ["media", "video", "audio", "image", "content"])):
                                print(f"[ResilientChatModel] [REACTIVE HEAL SYNC] Provider rejected media payload: {req_err}. Transducing via Omni layer and retrying...")
                                try:
                                    healed_kwargs = _heal_unsupported_media_sync(kwargs, getattr(self, "user_id", None))
                                    response = original_create(*args, **healed_kwargs)
                                    print(f"[ResilientChatModel] [REACTIVE HEAL SYNC] ✅ Retry succeeded seamlessly!")
                                except Exception as heal_err:
                                    print(f"[ResilientChatModel] [REACTIVE HEAL SYNC] Retry failed: {heal_err}")
                                    raise req_err
                            else:
                                print(f"[ResilientChatModel] [ERROR] Sync Request failed to {base_url_str}: {req_err}")
                                if hasattr(req_err, "response"):
                                    try:
                                        print(f"[ResilientChatModel] [ERROR] Status: {getattr(req_err.response, 'status_code', 'N/A')}, Body: {getattr(req_err.response, 'text', '')}")
                                    except Exception:
                                        pass
                                raise req_err

                        if kwargs.get("stream"):
                            def chunk_generator():
                                for chunk in response:
                                    if chunk.choices:
                                        delta = chunk.choices[0].delta
                                        reasoning = getattr(delta, "reasoning", None)
                                        if reasoning:
                                            try:
                                                delta.reasoning_content = reasoning
                                            except Exception:
                                                object.__setattr__(delta, "reasoning_content", reasoning)
                                    yield chunk
                            return WrappedSyncStream(response, chunk_generator())
                        return response

                    wrapped_create_sync._is_wrapped_reasoning = True
                    client_obj.chat.completions.create = wrapped_create_sync

        for attr in ["async_client", "root_async_client"]:
            client_obj = getattr(self, attr, None)
            if client_obj and hasattr(client_obj, "chat") and hasattr(client_obj.chat, "completions"):
                original_create = client_obj.chat.completions.create

                if not getattr(original_create, "_is_wrapped_reasoning", False):
                    async def wrapped_create_async(*args, **kwargs):
                        base_url_str = getattr(self, "openai_api_base", "")
                        if "openrouter.ai" in base_url_str:
                            extra_body = kwargs.get("extra_body") or {}
                            extra_body["include_reasoning"] = True
                            kwargs["extra_body"] = extra_body

                        try:
                            response = await original_create(*args, **kwargs)
                        except Exception as req_err:
                            err_str = str(req_err).lower()
                            # ── Reactive Fallback: Self-healing on 400 unsupported media type ──
                            if "unsupported media type" in err_str or ("400" in err_str and any(w in err_str for w in ["media", "video", "audio", "image", "content"])):
                                print(f"[ResilientChatModel] [REACTIVE HEAL] Provider rejected media payload: {req_err}. Transducing via Omni layer and retrying...")
                                try:
                                    healed_kwargs = await _aheal_unsupported_media(kwargs, getattr(self, "user_id", None))
                                    response = await original_create(*args, **healed_kwargs)
                                    print(f"[ResilientChatModel] [REACTIVE HEAL] ✅ Retry succeeded seamlessly!")
                                except Exception as heal_err:
                                    print(f"[ResilientChatModel] [REACTIVE HEAL] Retry failed: {heal_err}")
                                    raise req_err
                            else:
                                print(f"[ResilientChatModel] [ERROR] Request failed to {base_url_str}: {req_err}")
                                if hasattr(req_err, "response"):
                                    try:
                                        print(f"[ResilientChatModel] [ERROR] Status: {getattr(req_err.response, 'status_code', 'N/A')}, Body: {getattr(req_err.response, 'text', '')}")
                                    except Exception:
                                        pass
                                raise req_err

                        if kwargs.get("stream"):
                            async def chunk_generator():
                                async for chunk in response:
                                    if chunk.choices:
                                        delta = chunk.choices[0].delta
                                        reasoning = getattr(delta, "reasoning", None)
                                        if reasoning:
                                            try:
                                                delta.reasoning_content = reasoning
                                            except Exception:
                                                object.__setattr__(delta, "reasoning_content", reasoning)
                                    yield chunk
                            return WrappedAsyncStream(response, chunk_generator())
                        return response

                    wrapped_create_async._is_wrapped_reasoning = True
                    client_obj.chat.completions.create = wrapped_create_async
        return res

    def _get_llm_config_from_agent_configs(self) -> tuple[str, str, str]:
        """Read (base_url, api_key, model) from agent_configs row by self.agent_config_id."""
        try:
            from supabase import create_client, ClientOptions
            from research_agent.tools.provider_engine import resolve_provider_credentials, get_settings

            url = os.environ.get("SUPABASE_URL", "").rstrip("/")
            key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
            if not url or not key:
                raise RuntimeError("SUPABASE_URL/SUPABASE_ANON_KEY not set")

            opts = ClientOptions(postgrest_client_timeout=300, storage_client_timeout=300)
            client = create_client(url, key, options=opts)
            resp = client.rpc("get_agent_config_admin", {"p_agent_config_id": self.agent_config_id}).execute()
            if not resp.data:
                raise RuntimeError(f"agent_config_id {self.agent_config_id} not found")

            provider = (resp.data.get("provider") or "openrouter").strip().lower()
            model_name = (resp.data.get("model") or "").strip()
            user_id = resp.data.get("user_id")

            object.__setattr__(self, "user_id", user_id)

            db_settings = get_settings(user_id)
            base_url, api_key, model_name = resolve_provider_credentials(
                provider, model_name, settings=db_settings, user_id=user_id
            )

            print(f"[ResilientChatModel] [INFO] agent_configs reload: provider={provider}, model={model_name}, base_url={base_url}")
            return base_url, api_key, model_name

        except Exception as e:
            print(f"[ResilientChatModel] [WARN] _get_llm_config_from_agent_configs failed ({e}), keeping current settings")
            current_model = getattr(self, "model_name", None) or getattr(self, "model", "google/gemini-2.5-flash")
            current_base_url = getattr(self, "openai_api_base", None) or ""

            if "openrouter" in current_base_url and current_model.startswith("openrouter/"):
                current_model = current_model[len("openrouter/"):]

            raw_key = getattr(self, "openai_api_key", None)
            if isinstance(raw_key, SecretStr):
                current_api_key = raw_key.get_secret_value()
            else:
                current_api_key = str(raw_key) if raw_key else ""
            return current_base_url, current_api_key, current_model

    def _filter_messages_by_capability(self, messages: list) -> list:
        """Synchronously normalize multimodal blocks in messages via Hybrid Proactive Capability Filter."""
        if getattr(self, "is_omni_call", False):
            return messages

        from research_agent.preflight import (
            get_model_capabilities, get_extraction_prompts,
            run_omni_gemini_direct, run_omni_gateway, make_system_note,
            url_to_base64_data_uri, is_document_block, convert_document_to_markdown,
            collect_attachment_url, append_attachment_links
        )
        from research_agent.tools.provider_engine import get_settings, active_user_id

        raw_model = getattr(self, "model_name", None) or getattr(self, "model", "unknown-model")
        model_name = str(raw_model).lower()
        base_url = str(getattr(self, "openai_api_base", None) or getattr(self, "base_url", "")).lower()

        provider = getattr(self, "provider", None)
        if not provider:
            if "meta.ai" in base_url:
                provider = "meta"
            elif "together" in base_url:
                provider = "together"
            elif "openrouter" in base_url:
                provider = "openrouter"
            elif "generativelanguage.googleapis.com" in base_url:
                provider = "gemini"
            elif "groq.com" in base_url:
                provider = "groq"
            elif "cerebras" in base_url:
                provider = "cerebras"
            elif "/" in raw_model:
                provider = raw_model.split("/")[0]
            else:
                provider = "openrouter"

        user_id = getattr(self, "user_id", None) or active_user_id.get()
        caps = get_model_capabilities(provider, raw_model, user_id=user_id)
        supports_image = caps.get("vision", False)
        supports_audio = caps.get("audioInput", False)
        supports_video = caps.get("videoInput", False)
        supports_pdf = caps.get("pdf", False)

        db_settings = get_settings(user_id)
        omni_provider = db_settings.get("omni_provider", "gemini").strip().lower()
        omni_model = db_settings.get("omni_model", "gemini-2.5-flash").strip()
        prompts = get_extraction_prompts(user_id)

        cleaned_messages = []
        for msg in messages:
            new_msg = msg
            # Sanitize tool call names across all providers
            if hasattr(new_msg, "tool_calls") and new_msg.tool_calls:
                cleaned_tcs = []
                for tc in new_msg.tool_calls:
                    tc_d = dict(tc)
                    if "name" in tc_d and ":" in tc_d["name"]:
                        tc_d["name"] = tc_d["name"].split(":")[-1]
                    cleaned_tcs.append(tc_d)
                if hasattr(new_msg, "model_copy"):
                    new_msg = new_msg.model_copy(update={"tool_calls": cleaned_tcs})
                elif hasattr(new_msg, "copy"):
                    new_msg = new_msg.copy(update={"tool_calls": cleaned_tcs})

            if not hasattr(new_msg, "content") or not isinstance(new_msg.content, list):
                cleaned_messages.append(new_msg)
                continue

            new_content = []
            # Capture public storage URLs BEFORE normalization rewrites media
            # blocks to inline base64 (capable models), so the agent can still
            # pass the real URL to tools that require one (social savers, etc).
            attachment_links: list = []
            for block in new_msg.content:
                collect_attachment_url(block, attachment_links)

            for block in new_msg.content:
                if not isinstance(block, dict):
                    new_content.append(block)
                    continue

                block_type = block.get("type", "")
                block_mime = (block.get("mediaType") or block.get("mimeType") or "").lower()

                if block_type == "text":
                    new_content.append(block)

                elif is_document_block(block):
                    doc_md = convert_document_to_markdown(block, user_id)
                    if doc_md:
                        new_content.append({"type": "text", "text": doc_md})
                    else:
                        # Fallback for scanned PDF / unparsed documents
                        url = block.get("data", "") or block.get("url", "") or block.get("image_url", {}).get("url", "") or block.get("image", "")
                        url_lower = url.lower()
                        is_pdf = url.startswith("data:application/pdf") or url_lower.endswith(".pdf") or "pdf" in block_mime or block.get("mimeType") == "application/pdf"
                        if is_pdf:
                            if "claude" in model_name:
                                if url.startswith("http://") or url.startswith("https://"):
                                    url = url_to_base64_data_uri(url)
                                base64_data = url.split(",")[1] if "," in url else url
                                new_content.append({
                                    "type": "document",
                                    "source": {"type": "base64", "media_type": "application/pdf", "data": base64_data}
                                })
                            elif supports_pdf:
                                if url.startswith("http://") or url.startswith("https://"):
                                    url = url_to_base64_data_uri(url)
                                new_content.append({"type": "image_url", "image_url": {"url": url}})
                            else:
                                analysis = run_omni_gemini_direct(prompts["document"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["document"], block, user_id)
                                new_content.append(make_system_note(block, url, omni_model, analysis))
                        else:
                            analysis = run_omni_gemini_direct(prompts["document"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["document"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("image_url", "image"):
                    url = block.get("image_url", {}).get("url", "") if block_type == "image_url" else block.get("image", "")
                    url_lower = url.lower()
                    is_audio = url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")) or "audio" in block_mime
                    is_video = url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")) or "video" in block_mime

                    if is_audio:
                        if supports_audio:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            b64 = url.split(",")[1] if "," in url else url
                            fmt = "mp3" if "mp3" in url_lower else "wav"
                            new_content.append({"type": "input_audio", "input_audio": {"data": b64, "format": fmt}})
                        else:
                            analysis = run_omni_gemini_direct(prompts["audio"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["audio"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_video:
                        if supports_video:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = run_omni_gemini_direct(prompts["video"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["video"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        # Image block
                        if supports_image:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = run_omni_gemini_direct(prompts["image"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["image"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("audio", "input_audio"):
                    url = block.get("audio", "") or block.get("input_audio", {}).get("data", "")
                    if supports_audio:
                        if url.startswith("http://") or url.startswith("https://"):
                            url = url_to_base64_data_uri(url)
                        b64 = url.split(",")[1] if "," in url else url
                        fmt = "mp3" if "mp3" in url.lower() else "wav"
                        new_content.append({"type": "input_audio", "input_audio": {"data": b64, "format": fmt}})
                    else:
                        analysis = run_omni_gemini_direct(prompts["audio"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["audio"], block, user_id)
                        new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("video", "video_url"):
                    url = block.get("video", "") or block.get("video_url", {}).get("url", "")
                    if supports_video:
                        if url.startswith("http://") or url.startswith("https://"):
                            url = url_to_base64_data_uri(url)
                        new_content.append({"type": "image_url", "image_url": {"url": url}})
                    else:
                        analysis = run_omni_gemini_direct(prompts["video"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["video"], block, user_id)
                        new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("file", "document"):
                    url = block.get("data", "") or block.get("url", "")
                    url_lower = url.lower()
                    is_audio = url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")) or "audio" in block_mime
                    is_video = url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")) or "video" in block_mime
                    is_image = "image" in block_mime or url_lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))

                    if is_audio:
                        if supports_audio:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            b64 = url.split(",")[1] if "," in url else url
                            fmt = "mp3" if "mp3" in url_lower else "wav"
                            new_content.append({"type": "input_audio", "input_audio": {"data": b64, "format": fmt}})
                        else:
                            analysis = run_omni_gemini_direct(prompts["audio"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["audio"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_video:
                        if supports_video:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = run_omni_gemini_direct(prompts["video"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["video"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_image:
                        if supports_image:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = run_omni_gemini_direct(prompts["image"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["image"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        new_content.append(block)
                else:
                    new_content.append(block)

            # Re-attach the public storage URLs of every attachment so the agent
            # can hand them to tools that require a public URL, regardless of
            # whether the model consumed the media natively or via Omni.
            append_attachment_links(new_content, attachment_links)

            has_media = any(isinstance(b, dict) and b.get("type") in ("image_url", "input_audio", "audio", "video", "document") for b in new_content)
            if not has_media and new_content:
                text_chunks = []
                for b in new_content:
                    if isinstance(b, str):
                        text_chunks.append(b)
                    elif isinstance(b, dict) and b.get("type") == "text":
                        t_val = b.get("text", "")
                        if t_val:
                            text_chunks.append(t_val)
                final_content = "\n\n".join(text_chunks) if text_chunks else ""
            else:
                final_content = new_content

            if hasattr(new_msg, "model_copy"):
                new_msg = new_msg.model_copy(update={"content": final_content})
            elif hasattr(new_msg, "copy"):
                new_msg = new_msg.copy(update={"content": final_content})
            cleaned_messages.append(new_msg)
        return cleaned_messages

    async def _filter_messages_by_capability_async(self, messages: list) -> list:
        """Asynchronously normalize multimodal blocks in messages via Hybrid Proactive Capability Filter."""
        if getattr(self, "is_omni_call", False):
            return messages

        from research_agent.preflight import (
            get_model_capabilities, get_extraction_prompts,
            run_omni_gemini_direct_async, run_omni_gateway_async, make_system_note,
            url_to_base64_data_uri, is_document_block, convert_document_to_markdown_async,
            collect_attachment_url, append_attachment_links
        )
        from research_agent.tools.provider_engine import get_settings, active_user_id

        raw_model = getattr(self, "model_name", None) or getattr(self, "model", "unknown-model")
        model_name = str(raw_model).lower()
        base_url = str(getattr(self, "openai_api_base", None) or getattr(self, "base_url", "")).lower()

        provider = getattr(self, "provider", None)
        if not provider:
            if "meta.ai" in base_url:
                provider = "meta"
            elif "together" in base_url:
                provider = "together"
            elif "openrouter" in base_url:
                provider = "openrouter"
            elif "generativelanguage.googleapis.com" in base_url:
                provider = "gemini"
            elif "groq.com" in base_url:
                provider = "groq"
            elif "cerebras" in base_url:
                provider = "cerebras"
            elif "/" in raw_model:
                provider = raw_model.split("/")[0]
            else:
                provider = "openrouter"

        user_id = getattr(self, "user_id", None) or active_user_id.get()
        caps = get_model_capabilities(provider, raw_model, user_id=user_id)
        supports_image = caps.get("vision", False)
        supports_audio = caps.get("audioInput", False)
        supports_video = caps.get("videoInput", False)
        supports_pdf = caps.get("pdf", False)

        db_settings = get_settings(user_id)
        omni_provider = db_settings.get("omni_provider", "gemini").strip().lower()
        omni_model = db_settings.get("omni_model", "gemini-2.5-flash").strip()
        prompts = get_extraction_prompts(user_id)

        cleaned_messages = []
        for msg in messages:
            new_msg = msg
            # Sanitize tool call names across all providers
            if hasattr(new_msg, "tool_calls") and new_msg.tool_calls:
                cleaned_tcs = []
                for tc in new_msg.tool_calls:
                    tc_d = dict(tc)
                    if "name" in tc_d and ":" in tc_d["name"]:
                        tc_d["name"] = tc_d["name"].split(":")[-1]
                    cleaned_tcs.append(tc_d)
                if hasattr(new_msg, "model_copy"):
                    new_msg = new_msg.model_copy(update={"tool_calls": cleaned_tcs})
                elif hasattr(new_msg, "copy"):
                    new_msg = new_msg.copy(update={"tool_calls": cleaned_tcs})

            if not hasattr(new_msg, "content") or not isinstance(new_msg.content, list):
                cleaned_messages.append(new_msg)
                continue

            new_content = []
            # Capture public storage URLs BEFORE normalization rewrites media
            # blocks to inline base64 (capable models), so the agent can still
            # pass the real URL to tools that require one (social savers, etc).
            attachment_links: list = []
            for block in new_msg.content:
                collect_attachment_url(block, attachment_links)

            for block in new_msg.content:
                if not isinstance(block, dict):
                    new_content.append(block)
                    continue

                block_type = block.get("type", "")
                block_mime = (block.get("mediaType") or block.get("mimeType") or "").lower()

                if block_type == "text":
                    new_content.append(block)

                elif is_document_block(block):
                    doc_md = await convert_document_to_markdown_async(block, user_id)
                    if doc_md:
                        new_content.append({"type": "text", "text": doc_md})
                    else:
                        # Fallback for scanned PDF / unparsed documents
                        url = block.get("data", "") or block.get("url", "") or block.get("image_url", {}).get("url", "") or block.get("image", "")
                        url_lower = url.lower()
                        is_pdf = url.startswith("data:application/pdf") or url_lower.endswith(".pdf") or "pdf" in block_mime or block.get("mimeType") == "application/pdf"
                        if is_pdf:
                            if "claude" in model_name:
                                if url.startswith("http://") or url.startswith("https://"):
                                    url = url_to_base64_data_uri(url)
                                base64_data = url.split(",")[1] if "," in url else url
                                new_content.append({
                                    "type": "document",
                                    "source": {"type": "base64", "media_type": "application/pdf", "data": base64_data}
                                })
                            elif supports_pdf:
                                if url.startswith("http://") or url.startswith("https://"):
                                    url = url_to_base64_data_uri(url)
                                new_content.append({"type": "image_url", "image_url": {"url": url}})
                            else:
                                analysis = await run_omni_gemini_direct_async(prompts["document"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["document"], block, user_id)
                                new_content.append(make_system_note(block, url, omni_model, analysis))
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["document"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["document"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("image_url", "image"):
                    url = block.get("image_url", {}).get("url", "") if block_type == "image_url" else block.get("image", "")
                    url_lower = url.lower()
                    is_audio = url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")) or "audio" in block_mime
                    is_video = url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")) or "video" in block_mime

                    if is_audio:
                        if supports_audio:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            b64 = url.split(",")[1] if "," in url else url
                            fmt = "mp3" if "mp3" in url_lower else "wav"
                            new_content.append({"type": "input_audio", "input_audio": {"data": b64, "format": fmt}})
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["audio"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["audio"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_video:
                        if supports_video:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["video"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["video"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        # Image block
                        if supports_image:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["image"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["image"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("audio", "input_audio"):
                    url = block.get("audio", "") or block.get("input_audio", {}).get("data", "")
                    if supports_audio:
                        if url.startswith("http://") or url.startswith("https://"):
                            url = url_to_base64_data_uri(url)
                        b64 = url.split(",")[1] if "," in url else url
                        fmt = "mp3" if "mp3" in url.lower() else "wav"
                        new_content.append({"type": "input_audio", "input_audio": {"data": b64, "format": fmt}})
                    else:
                        analysis = await run_omni_gemini_direct_async(prompts["audio"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["audio"], block, user_id)
                        new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("video", "video_url"):
                    url = block.get("video", "") or block.get("video_url", {}).get("url", "")
                    if supports_video:
                        if url.startswith("http://") or url.startswith("https://"):
                            url = url_to_base64_data_uri(url)
                        new_content.append({"type": "image_url", "image_url": {"url": url}})
                    else:
                        analysis = await run_omni_gemini_direct_async(prompts["video"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["video"], block, user_id)
                        new_content.append(make_system_note(block, url, omni_model, analysis))

                elif block_type in ("file", "document"):
                    url = block.get("data", "") or block.get("url", "")
                    url_lower = url.lower()
                    is_audio = url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")) or "audio" in block_mime
                    is_video = url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")) or "video" in block_mime
                    is_image = "image" in block_mime or url_lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))

                    if is_audio:
                        if supports_audio:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            b64 = url.split(",")[1] if "," in url else url
                            fmt = "mp3" if "mp3" in url_lower else "wav"
                            new_content.append({"type": "input_audio", "input_audio": {"data": b64, "format": fmt}})
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["audio"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["audio"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_video:
                        if supports_video:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["video"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["video"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_image:
                        if supports_image:
                            if url.startswith("http://") or url.startswith("https://"):
                                url = url_to_base64_data_uri(url)
                            new_content.append({"type": "image_url", "image_url": {"url": url}})
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["image"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["image"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        new_content.append(block)
                else:
                    new_content.append(block)

            # Re-attach the public storage URLs of every attachment so the agent
            # can hand them to tools that require a public URL, regardless of
            # whether the model consumed the media natively or via Omni.
            append_attachment_links(new_content, attachment_links)

            has_media = any(isinstance(b, dict) and b.get("type") in ("image_url", "input_audio", "audio", "video", "document") for b in new_content)
            if not has_media and new_content:
                text_chunks = []
                for b in new_content:
                    if isinstance(b, str):
                        text_chunks.append(b)
                    elif isinstance(b, dict) and b.get("type") == "text":
                        t_val = b.get("text", "")
                        if t_val:
                            text_chunks.append(t_val)
                final_content = "\n\n".join(text_chunks) if text_chunks else ""
            else:
                final_content = new_content

            if hasattr(new_msg, "model_copy"):
                new_msg = new_msg.model_copy(update={"content": final_content})
            elif hasattr(new_msg, "copy"):
                new_msg = new_msg.copy(update={"content": final_content})
            cleaned_messages.append(new_msg)
        return cleaned_messages

    async def _force_omni_transduction_async(self, messages: list) -> list:
        """Force Omni transduction on all media blocks (reactive fallback after direct attempt fails)."""
        from research_agent.preflight import (
            get_extraction_prompts, run_omni_gemini_direct_async,
            run_omni_gateway_async, make_system_note,
            collect_attachment_url, append_attachment_links
        )
        from research_agent.tools.provider_engine import get_settings, active_user_id

        user_id = getattr(self, "user_id", None) or active_user_id.get()
        db_settings = get_settings(user_id)
        prompts = get_extraction_prompts(user_id)
        omni_provider = db_settings.get("omni_provider", "openrouter").strip().lower()
        omni_model = db_settings.get("omni_model", "gemini-2.5-flash").strip()

        def _prompt_key_for_url(url: str) -> str:
            url_lower = url.lower()
            if url.startswith("data:application/pdf") or url_lower.endswith(".pdf"):
                return "document"
            if url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")):
                return "audio"
            if url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")):
                return "video"
            return "image"

        def _note_url(url: str) -> str:
            if url.startswith(("http://", "https://")):
                return url
            if url.startswith("data:"):
                mime = url.split(";")[0].replace("data:", "") if ";" in url else "unknown"
                return f"<inline {mime} attachment>"
            return url or "<attachment>"

        transduced = []
        for msg in messages:
            if not hasattr(msg, "content") or not isinstance(msg.content, list):
                transduced.append(msg)
                continue

            new_content = []
            # Preserve public storage URLs so the agent can still pass them to
            # tools that require a public URL after Omni transduction.
            attachment_links: list = []
            for block in msg.content:
                collect_attachment_url(block, attachment_links)

            for block in msg.content:
                if not isinstance(block, dict):
                    new_content.append(block)
                    continue

                block_type = block.get("type")
                if block_type == "text":
                    new_content.append(block)
                elif block_type == "image_url":
                    url = block.get("image_url", {}).get("url", "")
                    prompt_key = _prompt_key_for_url(url)
                    analysis = await run_omni_gemini_direct_async(prompts[prompt_key], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts[prompt_key], block, user_id)
                    new_content.append(make_system_note(block, _note_url(url), omni_model, analysis))
                elif block_type in ("audio", "input_audio"):
                    url = block.get("audio", "") or block.get("input_audio", {}).get("data", "")
                    analysis = await run_omni_gemini_direct_async(prompts["audio"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["audio"], block, user_id)
                    new_content.append(make_system_note(block, _note_url(url), omni_model, analysis))
                elif block_type == "video":
                    url = block.get("video", "")
                    analysis = await run_omni_gemini_direct_async(prompts["video"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["video"], block, user_id)
                    new_content.append(make_system_note(block, _note_url(url), omni_model, analysis))
                elif is_document_block(block):
                    doc_md = await convert_document_to_markdown_async(block, user_id)
                    if doc_md:
                        new_content.append({"type": "text", "text": doc_md})
                    else:
                        url = block.get("data", "") or block.get("url", "")
                        analysis = await run_omni_gemini_direct_async(prompts["document"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["document"], block, user_id)
                        new_content.append(make_system_note(block, _note_url(url), omni_model, analysis))
                else:
                    new_content.append(block)

            append_attachment_links(new_content, attachment_links)

            text_chunks = []
            for b in new_content:
                if isinstance(b, str):
                    text_chunks.append(b)
                elif isinstance(b, dict) and b.get("type") == "text":
                    t_val = b.get("text", "")
                    if t_val:
                        text_chunks.append(t_val)
            final_content = "\n\n".join(text_chunks) if text_chunks else ""

            if hasattr(msg, "model_copy"):
                new_msg = msg.model_copy(update={"content": final_content})
            elif hasattr(msg, "copy"):
                new_msg = msg.copy(update={"content": final_content})
            else:
                new_msg = msg
            transduced.append(new_msg)
        return transduced

    def _force_omni_transduction_sync(self, messages: list) -> list:
        """Sync fallback for forced Omni transduction."""
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(asyncio.run, self._force_omni_transduction_async(messages)).result()

    def _filter_input(self, input_val):
        if isinstance(input_val, list):
            return self._filter_messages_by_capability(input_val)
        elif hasattr(input_val, "to_messages"):
            return self._filter_messages_by_capability(input_val.to_messages())
        return input_val

    def _filter_input_async(self, input_val):
        if isinstance(input_val, list):
            return self._filter_messages_by_capability_async(input_val)
        elif hasattr(input_val, "to_messages"):
            return self._filter_messages_by_capability_async(input_val.to_messages())
        return input_val

    def _is_fatal_error(self, e: Exception) -> bool:
        error_msg = str(e).lower()
        return any(code in error_msg for code in ["401", "403", "unauthorized", "forbidden", "invalid api key"])

    def _is_rate_limit(self, e: Exception) -> bool:
        msg = str(e).lower()
        return "429" in msg or "rate limit" in msg or "too many requests" in msg or "rate_limit" in msg

    def _is_thought_signature_error(self, e: Exception) -> bool:
        msg = str(e).lower()
        return any(k in msg for k in ["thought_signature", "thought signature", "thinking_signature", "missing a thought", "functioncall parts"])

    def _is_multimodal_rejection(self, e: Exception) -> bool:
        """Detect if provider rejected request due to unsupported image/audio/video/PDF payload."""
        msg = str(e).lower()
        if self._is_thought_signature_error(e):
            return False
        markers = [
            "image_url", "multimodal", "unsupported content", "invalid content type",
            "audio not supported", "file not supported", "unable to download image",
            "data uri", "unrecognized content part", "does not support image",
            "does not support vision", "only supported on vision", "expected a string",
            "unsupported modality", "modality", "image is not supported",
            "no endpoints found", "support image input", "content part",
            "does not support audio", "does not support video", "does not support pdf",
            "invalid image", "invalid audio", "invalid video", "invalid file"
        ]
        return any(m in msg for m in markers)

    def _sanitize_tool_history_for_gemini(self, messages: list) -> list:
        """Removes or converts raw tool_calls from previous turns that lack Gemini thought signatures."""
        from langchain_core.messages import HumanMessage, AIMessage, ToolMessage, FunctionMessage
        sanitized = []
        for msg in messages:
            if isinstance(msg, AIMessage) and getattr(msg, "tool_calls", None):
                tool_descs = []
                for tc in msg.tool_calls:
                    t_name = tc.get("name", "tool").split(":")[-1]
                    t_args = tc.get("args", {})
                    tool_descs.append(f"[Executed Tool: {t_name} with parameters: {t_args}]")
                summary = "\n".join(tool_descs)
                c = msg.content if isinstance(msg.content, str) and msg.content else summary
                sanitized.append(AIMessage(content=c, id=getattr(msg, "id", None)))
            elif isinstance(msg, (ToolMessage, FunctionMessage)):
                t_name = (getattr(msg, "name", None) or "tool").split(":")[-1]
                sanitized.append(HumanMessage(content=f"[Tool Result for '{t_name}']:\n{msg.content}", id=getattr(msg, "id", None)))
            else:
                sanitized.append(msg)
        return sanitized

    def _get_backoff_delay(self, attempt: int) -> float:
        base_delay = _LLM_BASE_DELAY * (2 ** (attempt - 1))
        jitter = random.uniform(0.0, 0.2 * base_delay)
        return min(base_delay + jitter, 60.0)

    async def astream(self, *args, **kwargs):
        self._set_active_user_from_config(*args, **kwargs)
        self._resolve_dynamic_fields()
        args_list = list(args)
        if len(args_list) > 0:
            args_list[0] = await self._filter_input_async(args_list[0])
        args = tuple(args_list)

        for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
            stream_started = False
            try:
                async for chunk in super().astream(*args, **kwargs):
                    stream_started = True
                    yield chunk
                return
            except Exception as e:
                if stream_started:
                    print(f"[LLM] [WARN] Stream failed AFTER first token on attempt {attempt}: {e}")
                    raise

                # Gemini Thought Signature Remediation
                if self._is_thought_signature_error(e):
                    print(f"[ResilientChatModel] Gemini thought_signature mismatch detected ({e}). Sanitizing tool history context...")
                    try:
                        sanitized = self._sanitize_tool_history_for_gemini(args[0])
                        args_list = list(args)
                        args_list[0] = sanitized
                        args = tuple(args_list)
                        async for chunk in super().astream(*args, **kwargs):
                            yield chunk
                        return
                    except Exception as san_err:
                        print(f"[ResilientChatModel] Gemini thought_signature recovery failed: {san_err}")
                        raise san_err

                # Tier 2 Reactive Multimodal Fallback (direct inline failed → transduce via Omni)
                if not getattr(self, "is_omni_call", False) and self._is_multimodal_rejection(e):
                    print(f"[ResilientChatModel] Multimodal rejection caught from provider API ({e}). Falling back to Omni transduction...")
                    try:
                        fallback_messages = await self._force_omni_transduction_async(args[0])
                        args_list = list(args)
                        args_list[0] = fallback_messages
                        args = tuple(args_list)
                        async for chunk in super().astream(*args, **kwargs):
                            yield chunk
                        return
                    except Exception as fallback_err:
                        print(f"[ResilientChatModel] Omni Preflight fallback stream failed: {fallback_err}")
                        raise fallback_err

                if self._is_fatal_error(e):
                    raise
                if attempt == _LLM_MAX_ATTEMPTS:
                    raise
                if self._is_rate_limit(e):
                    await asyncio.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    await asyncio.sleep(self._get_backoff_delay(attempt))

    async def ainvoke(self, *args, **kwargs):
        self._set_active_user_from_config(*args, **kwargs)
        self._resolve_dynamic_fields()
        args_list = list(args)
        if len(args_list) > 0:
            args_list[0] = await self._filter_input_async(args_list[0])
        args = tuple(args_list)

        for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
            try:
                return await super().ainvoke(*args, **kwargs)
            except Exception as e:
                # Gemini Thought Signature Remediation
                if self._is_thought_signature_error(e):
                    print(f"[ResilientChatModel] Gemini thought_signature mismatch detected ({e}). Sanitizing tool history context...")
                    try:
                        sanitized = self._sanitize_tool_history_for_gemini(args[0])
                        args_list = list(args)
                        args_list[0] = sanitized
                        args = tuple(args_list)
                        return await super().ainvoke(*args, **kwargs)
                    except Exception as san_err:
                        print(f"[ResilientChatModel] Gemini thought_signature recovery failed: {san_err}")
                        raise san_err

                # Tier 2 Reactive Multimodal Fallback (direct inline failed → transduce via Omni)
                if not getattr(self, "is_omni_call", False) and self._is_multimodal_rejection(e):
                    print(f"[ResilientChatModel] Multimodal rejection caught from provider API ({e}). Falling back to Omni transduction...")
                    try:
                        fallback_messages = await self._force_omni_transduction_async(args[0])
                        args_list = list(args)
                        args_list[0] = fallback_messages
                        args = tuple(args_list)
                        return await super().ainvoke(*args, **kwargs)
                    except Exception as fallback_err:
                        print(f"[ResilientChatModel] Omni Preflight fallback ainvoke failed: {fallback_err}")
                        raise fallback_err

                if self._is_fatal_error(e):
                    raise
                if attempt == _LLM_MAX_ATTEMPTS:
                    raise
                if self._is_rate_limit(e):
                    await asyncio.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    await asyncio.sleep(self._get_backoff_delay(attempt))

    def invoke(self, *args, **kwargs):
        self._set_active_user_from_config(*args, **kwargs)
        self._resolve_dynamic_fields()
        args_list = list(args)
        if len(args_list) > 0:
            args_list[0] = self._filter_input(args_list[0])
        args = tuple(args_list)

        for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
            try:
                return super().invoke(*args, **kwargs)
            except Exception as e:
                # Gemini Thought Signature Remediation
                if self._is_thought_signature_error(e):
                    print(f"[ResilientChatModel] Gemini thought_signature mismatch detected ({e}). Sanitizing tool history context...")
                    try:
                        sanitized = self._sanitize_tool_history_for_gemini(args[0])
                        args_list = list(args)
                        args_list[0] = sanitized
                        args = tuple(args_list)
                        return super().invoke(*args, **kwargs)
                    except Exception as san_err:
                        print(f"[ResilientChatModel] Gemini thought_signature recovery failed: {san_err}")
                        raise san_err

                # Tier 2 Reactive Multimodal Fallback (direct inline failed → transduce via Omni)
                if not getattr(self, "is_omni_call", False) and self._is_multimodal_rejection(e):
                    print(f"[ResilientChatModel] Multimodal rejection caught from provider API ({e}). Falling back to Omni transduction...")
                    try:
                        fallback_messages = self._force_omni_transduction_sync(args[0])
                        args_list = list(args)
                        args_list[0] = fallback_messages
                        args = tuple(args_list)
                        return super().invoke(*args, **kwargs)
                    except Exception as fallback_err:
                        print(f"[ResilientChatModel] Omni Preflight fallback invoke failed: {fallback_err}")
                        raise fallback_err

                if self._is_fatal_error(e):
                    raise
                if attempt == _LLM_MAX_ATTEMPTS:
                    raise
                if self._is_rate_limit(e):
                    time.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    time.sleep(self._get_backoff_delay(attempt))

