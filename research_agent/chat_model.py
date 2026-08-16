"""ResilientChatModel — Enterprise rate-limit-aware LLM wrapper with dynamic configuration,
reasoning token preservation, memory injection, and preflight multimodal normalization.
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


class ResilientChatModel(ChatOpenAI):
    """Wraps ChatOpenAI with rate-limit-aware retries tuned for enterprise LLM APIs."""

    max_retries: int = 0  # Disable built-in tenacity retries — we handle it ourselves
    agent_type: str = "main_agent"
    agent_config_id: str = ""  # UUID from agent_configs table; when set, dynamic reload reads per-workflow settings
    is_omni_call: bool = False

    def _inject_memory_to_messages(self, messages: list) -> list:
        """Inject USER.md + MEMORY.md + Honcho context into the LAST HumanMessage."""
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
                    content = m.content if hasattr(m, "content") else m.get("content", "")
                    if isinstance(content, str):
                        user_msg = content[:500]

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
                orig = target.content if isinstance(target.content, str) else ""
                if "<memory-context>" not in orig:
                    new_messages[last_human_idx] = HumanMessage(content=f"{orig}\n\n{context_block}")
            elif isinstance(target, dict):
                orig = target.get("content", "") or ""
                if "<memory-context>" not in orig:
                    new_messages[last_human_idx] = dict(target, content=f"{orig}\n\n{context_block}")
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
                        if "openrouter.ai" in getattr(self, "openai_api_base", ""):
                            extra_body = kwargs.get("extra_body") or {}
                            extra_body["include_reasoning"] = True
                            kwargs["extra_body"] = extra_body

                        response = original_create(*args, **kwargs)
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
                        if "openrouter.ai" in getattr(self, "openai_api_base", ""):
                            extra_body = kwargs.get("extra_body") or {}
                            extra_body["include_reasoning"] = True
                            kwargs["extra_body"] = extra_body

                        response = await original_create(*args, **kwargs)
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
            from research_agent.tools.provider_engine import (
                get_provider_base_url, get_provider_api_key, get_provider_config,
                get_all_provider_names, get_settings
            )

            url = os.environ.get("SUPABASE_URL", "").rstrip("/")
            key = os.environ.get("SUPABASE_ANON_KEY", "")
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
            actual_provider = provider
            if actual_provider not in get_all_provider_names():
                actual_provider = "openrouter"

            base_url = get_provider_base_url(actual_provider)
            cfg = get_provider_config(actual_provider)
            if cfg and "base_url_env" in cfg and not base_url.endswith("/v1"):
                base_url = base_url + "/v1"

            if actual_provider == "openrouter":
                api_key = db_settings.get("openrouter_client_api_key", "").strip()
                if not api_key:
                    api_key = get_provider_api_key("openrouter")
            elif actual_provider == "gemini":
                api_key = db_settings.get("gemini_client_api_key", "").strip()
                if not api_key:
                    api_key = get_provider_api_key("gemini")
            else:
                api_key = get_provider_api_key(actual_provider)

            if not model_name:
                model_name = "google/gemini-2.5-flash"

            if actual_provider == "openrouter" and model_name.startswith("openrouter/"):
                model_name = model_name[len("openrouter/"):]

            print(f"[ResilientChatModel] [INFO] agent_configs reload: provider={actual_provider}, model={model_name}")
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
        """Synchronously normalize multimodal blocks in messages via Omni preflight."""
        if getattr(self, "is_omni_call", False):
            return messages

        from research_agent.preflight import (
            get_model_capabilities, get_extraction_prompts,
            run_omni_gemini_direct, run_omni_gateway, make_system_note
        )
        from research_agent.tools.provider_engine import get_settings, active_user_id

        raw_model = getattr(self, "model_name", None) or getattr(self, "model", "unknown-model")
        model_name = str(raw_model).lower()

        provider = "openrouter"
        if "/" in raw_model:
            provider = raw_model.split("/")[0]

        user_id = getattr(self, "user_id", None) or active_user_id.get()
        caps = get_model_capabilities(provider, raw_model, user_id=user_id)
        supports_image = caps.get("vision", False)
        supports_audio = caps.get("audioInput", False)
        supports_video = caps.get("videoInput", False)
        supports_pdf = caps.get("pdf", False)

        db_settings = get_settings(user_id)
        omni_provider = db_settings.get("omni_provider", "openrouter").strip().lower()
        omni_model = db_settings.get("omni_model", "google/gemini-2.5-flash").strip()
        prompts = get_extraction_prompts(user_id)

        cleaned_messages = []
        for msg in messages:
            if not hasattr(msg, "content") or not isinstance(msg.content, list):
                cleaned_messages.append(msg)
                continue

            new_content = []
            for block in msg.content:
                if not isinstance(block, dict):
                    new_content.append(block)
                    continue

                block_type = block.get("type")
                if block_type == "text":
                    new_content.append(block)
                elif block_type == "image_url":
                    url = block.get("image_url", {}).get("url", "")
                    url_lower = url.lower()
                    is_pdf = url.startswith("data:application/pdf") or url_lower.endswith(".pdf") or "mimetype=application/pdf" in url_lower
                    is_audio = url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")) or "audio" in url_lower
                    is_video = url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")) or "video" in url_lower
                    is_image = url.startswith("data:image/") or url_lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")) or (not url.startswith("data:") and not is_pdf and not is_audio and not is_video)

                    if is_image:
                        if supports_image:
                            new_content.append(block)
                        else:
                            analysis = run_omni_gemini_direct(prompts["image"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["image"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_pdf:
                        if "claude" in model_name:
                            base64_data = url.split(",")[1] if "," in url else url
                            new_content.append({
                                "type": "document",
                                "source": {"type": "base64", "media_type": "application/pdf", "data": base64_data}
                            })
                        elif supports_pdf:
                            new_content.append(block)
                        else:
                            analysis = run_omni_gemini_direct(prompts["document"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["document"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_audio:
                        if supports_audio:
                            new_content.append(block)
                        else:
                            analysis = run_omni_gemini_direct(prompts["audio"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["audio"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_video:
                        if supports_video:
                            new_content.append(block)
                        else:
                            analysis = run_omni_gemini_direct(prompts["video"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["video"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        new_content.append(block)

                elif block_type == "audio":
                    if supports_audio:
                        new_content.append(block)
                    else:
                        analysis = run_omni_gemini_direct(prompts["audio"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["audio"], block, user_id)
                        new_content.append(make_system_note(block, block.get("audio", ""), omni_model, analysis))
                elif block_type == "video":
                    if supports_video:
                        new_content.append(block)
                    else:
                        analysis = run_omni_gemini_direct(prompts["video"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["video"], block, user_id)
                        new_content.append(make_system_note(block, block.get("video", ""), omni_model, analysis))
                elif block_type == "file":
                    url = block.get("data", "")
                    if url.lower().endswith(".pdf") or block.get("mimeType") == "application/pdf":
                        if supports_pdf:
                            new_content.append(block)
                        else:
                            analysis = run_omni_gemini_direct(prompts["document"], block, user_id) if omni_provider == "gemini" else run_omni_gateway(prompts["document"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        new_content.append(block)
                else:
                    new_content.append(block)

            new_msg = msg.copy(update={"content": new_content}) if hasattr(msg, "copy") else msg
            cleaned_messages.append(new_msg)
        return cleaned_messages

    async def _filter_messages_by_capability_async(self, messages: list) -> list:
        """Asynchronously normalize multimodal blocks in messages via Omni preflight."""
        if getattr(self, "is_omni_call", False):
            return messages

        from research_agent.preflight import (
            get_model_capabilities, get_extraction_prompts,
            run_omni_gemini_direct_async, run_omni_gateway_async, make_system_note
        )
        from research_agent.tools.provider_engine import get_settings, active_user_id

        raw_model = getattr(self, "model_name", None) or getattr(self, "model", "unknown-model")
        model_name = str(raw_model).lower()

        provider = "openrouter"
        if "/" in raw_model:
            provider = raw_model.split("/")[0]

        user_id = getattr(self, "user_id", None) or active_user_id.get()

        def _resolve_caps_and_settings():
            c = get_model_capabilities(provider, raw_model, user_id=user_id)
            s = get_settings(user_id)
            p = get_extraction_prompts(user_id)
            return c, s, p

        caps, db_settings, prompts = await asyncio.to_thread(_resolve_caps_and_settings)
        supports_image = caps.get("vision", False)
        supports_audio = caps.get("audioInput", False)
        supports_video = caps.get("videoInput", False)
        supports_pdf = caps.get("pdf", False)

        omni_provider = db_settings.get("omni_provider", "openrouter").strip().lower()
        omni_model = db_settings.get("omni_model", "google/gemini-2.5-flash").strip()

        cleaned_messages = []
        for msg in messages:
            if not hasattr(msg, "content") or not isinstance(msg.content, list):
                cleaned_messages.append(msg)
                continue

            new_content = []
            for block in msg.content:
                if not isinstance(block, dict):
                    new_content.append(block)
                    continue

                block_type = block.get("type")
                if block_type == "text":
                    new_content.append(block)
                elif block_type == "image_url":
                    url = block.get("image_url", {}).get("url", "")
                    url_lower = url.lower()
                    is_pdf = url.startswith("data:application/pdf") or url_lower.endswith(".pdf") or "mimetype=application/pdf" in url_lower
                    is_audio = url.startswith("data:audio/") or url_lower.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")) or "audio" in url_lower
                    is_video = url.startswith("data:video/") or url_lower.endswith((".mp4", ".webm", ".mov", ".avi")) or "video" in url_lower
                    is_image = url.startswith("data:image/") or url_lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")) or (not url.startswith("data:") and not is_pdf and not is_audio and not is_video)

                    if is_image:
                        if supports_image:
                            new_content.append(block)
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["image"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["image"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_pdf:
                        if "claude" in model_name:
                            base64_data = url.split(",")[1] if "," in url else url
                            new_content.append({
                                "type": "document",
                                "source": {"type": "base64", "media_type": "application/pdf", "data": base64_data}
                            })
                        elif supports_pdf:
                            new_content.append(block)
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["document"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["document"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_audio:
                        if supports_audio:
                            new_content.append(block)
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["audio"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["audio"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    elif is_video:
                        if supports_video:
                            new_content.append(block)
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["video"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["video"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        new_content.append(block)

                elif block_type == "audio":
                    if supports_audio:
                        new_content.append(block)
                    else:
                        analysis = await run_omni_gemini_direct_async(prompts["audio"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["audio"], block, user_id)
                        new_content.append(make_system_note(block, block.get("audio", ""), omni_model, analysis))
                elif block_type == "video":
                    if supports_video:
                        new_content.append(block)
                    else:
                        analysis = await run_omni_gemini_direct_async(prompts["video"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["video"], block, user_id)
                        new_content.append(make_system_note(block, block.get("video", ""), omni_model, analysis))
                elif block_type == "file":
                    url = block.get("data", "")
                    if url.lower().endswith(".pdf") or block.get("mimeType") == "application/pdf":
                        if supports_pdf:
                            new_content.append(block)
                        else:
                            analysis = await run_omni_gemini_direct_async(prompts["document"], block, user_id) if omni_provider == "gemini" else await run_omni_gateway_async(prompts["document"], block, user_id)
                            new_content.append(make_system_note(block, url, omni_model, analysis))
                    else:
                        new_content.append(block)
                else:
                    new_content.append(block)

            new_msg = msg.copy(update={"content": new_content}) if hasattr(msg, "copy") else msg
            cleaned_messages.append(new_msg)
        return cleaned_messages

    def _filter_input(self, input_val):
        if isinstance(input_val, list):
            return self._filter_messages_by_capability(input_val)
        elif hasattr(input_val, "to_messages"):
            return self._filter_messages_by_capability(input_val.to_messages())
        return input_val

    async def _filter_input_async(self, input_val):
        if isinstance(input_val, list):
            return await self._filter_messages_by_capability_async(input_val)
        elif hasattr(input_val, "to_messages"):
            return await self._filter_messages_by_capability_async(input_val.to_messages())
        return input_val

    def _is_fatal_error(self, e: Exception) -> bool:
        error_msg = str(e).lower()
        return any(code in error_msg for code in ["401", "403", "unauthorized", "forbidden", "invalid api key"])

    def _is_rate_limit(self, e: Exception) -> bool:
        msg = str(e).lower()
        return "429" in msg or "rate limit" in msg or "too many requests" in msg or "rate_limit" in msg

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
                if self._is_fatal_error(e):
                    raise
                if attempt == _LLM_MAX_ATTEMPTS:
                    raise
                if self._is_rate_limit(e):
                    time.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    time.sleep(self._get_backoff_delay(attempt))
