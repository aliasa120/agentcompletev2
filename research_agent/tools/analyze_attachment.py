"""Omni Analyzer — Universal file & document analysis tool.

Analyzes ANY type of file via URL, attachment, or workspace path:
- Documents: PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, CSV, EPUB, HTML, TXT, JSON, XML, MD
- Images: PNG, JPG, JPEG, WebP, GIF, SVG, BMP, TIFF
- Audio: MP3, WAV, OGG, M4A, AAC, FLAC
- Video: MP4, AVI, MOV, WebM, MKV

Processing Pipeline:
1. Universal Source Resolution (URLs, Google Docs/Drive, Dropbox, GitHub, Workspace, Chat Attachments)
2. Tier 1: Fast Structured Document to Markdown Engine (MarkItDown + PyPDF + BS4 HTML extraction)
3. Tier 2: Seamless Multimodal Fallback (Gemini / Multimodal Omni Vision for scanned image PDFs, photos, audio, video)
"""

import os
import io
import uuid
import re
import base64
import mimetypes
import logging
import requests
import httpx
from typing import List, Optional, Tuple
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from research_agent.brand_assets import (
    asset_supports_direct_context,
    build_direct_context_payload,
    get_agent_brand_assets,
    get_agent_capabilities,
    resolve_selected_assets,
)
from research_agent.tools.provider_engine import (
    get_llm_config,
    get_settings,
    get_provider_base_url,
    get_provider_api_key,
    get_provider_config,
    get_all_provider_names,
    get_user_api_key,
    active_user_id,
)

logger = logging.getLogger("omni_analyzer")

_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _normalize_document_url(url: str) -> Tuple[str, str]:
    """Normalize online document/drive/dropbox/github share URLs for direct downloading."""
    clean_url = url.strip()
    filename = "document"

    # 1. Google Docs / Sheets / Slides export links
    if "docs.google.com/document/d/" in clean_url:
        doc_id_match = re.search(r"/document/d/([a-zA-Z0-9_-]+)", clean_url)
        if doc_id_match:
            doc_id = doc_id_match.group(1)
            clean_url = f"https://docs.google.com/document/d/{doc_id}/export?format=pdf"
            filename = f"google_doc_{doc_id[:8]}.pdf"
            return clean_url, filename

    if "docs.google.com/spreadsheets/d/" in clean_url:
        sheet_id_match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", clean_url)
        if sheet_id_match:
            sheet_id = sheet_id_match.group(1)
            clean_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
            filename = f"google_sheet_{sheet_id[:8]}.xlsx"
            return clean_url, filename

    if "docs.google.com/presentation/d/" in clean_url:
        pres_id_match = re.search(r"/presentation/d/([a-zA-Z0-9_-]+)", clean_url)
        if pres_id_match:
            pres_id = pres_id_match.group(1)
            clean_url = f"https://docs.google.com/presentation/d/{pres_id}/export/pdf"
            filename = f"google_slides_{pres_id[:8]}.pdf"
            return clean_url, filename

    # 2. Google Drive view link -> direct download link
    if "drive.google.com/file/d/" in clean_url:
        drive_id_match = re.search(r"/file/d/([a-zA-Z0-9_-]+)", clean_url)
        if drive_id_match:
            drive_id = drive_id_match.group(1)
            clean_url = f"https://drive.google.com/uc?export=download&id={drive_id}"
            filename = f"drive_file_{drive_id[:8]}"
            return clean_url, filename

    # 3. Dropbox share links (force dl=1)
    if "dropbox.com/" in clean_url:
        if "dl=0" in clean_url:
            clean_url = clean_url.replace("dl=0", "dl=1")
        elif "?" not in clean_url:
            clean_url += "?dl=1"

    # 4. GitHub blob -> raw
    if "github.com/" in clean_url and "/blob/" in clean_url:
        clean_url = clean_url.replace("github.com/", "raw.githubusercontent.com/").replace("/blob/", "/")

    # Extract filename from URL
    path_part = clean_url.split("?")[0].rstrip("/")
    base = os.path.basename(path_part)
    if base and "." in base:
        filename = base

    return clean_url, filename


def _detect_mime_type(filename: str, raw_bytes: bytes, header_mime: str = "") -> str:
    """Accurately detect MIME type using headers, magic bytes, and file extension."""
    if header_mime and "octet-stream" not in header_mime and "/" in header_mime:
        return header_mime.split(";")[0].strip().lower()

    # Magic byte sniffing
    if raw_bytes.startswith(b"%PDF-"):
        return "application/pdf"
    if raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw_bytes.startswith(b"GIF87a") or raw_bytes.startswith(b"GIF89a"):
        return "image/gif"
    if raw_bytes.startswith(b"RIFF") and b"WEBP" in raw_bytes[:16]:
        return "image/webp"
    if raw_bytes.startswith(b"PK\x03\x04"):
        lower_name = filename.lower()
        if lower_name.endswith(".docx"):
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if lower_name.endswith(".xlsx"):
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        if lower_name.endswith(".pptx"):
            return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        if lower_name.endswith(".epub"):
            return "application/epub+zip"
        return "application/zip"

    # Extension guessing
    guessed, _ = mimetypes.guess_type(filename)
    if guessed:
        return guessed.lower()

    # Text detection
    try:
        raw_bytes[:2048].decode("utf-8")
        if filename.lower().endswith((".html", ".htm")):
            return "text/html"
        if filename.lower().endswith(".json"):
            return "application/json"
        if filename.lower().endswith(".csv"):
            return "text/csv"
        return "text/plain"
    except UnicodeDecodeError:
        pass

    return "application/octet-stream"


def _extract_text_layer(raw_bytes: bytes, filename: str, mime_type: str, file_url: str, user_id: Optional[str]) -> Optional[str]:
    """Tier 1: Extract structured text and Markdown from documents using MarkItDown, PyPDF, and HTML parsers."""
    from research_agent.preflight import convert_document_to_markdown, is_document_block

    # 1. Primary: MarkItDown Engine
    doc_block = {"data": file_url, "filename": filename, "mediaType": mime_type, "raw_bytes": raw_bytes}
    if is_document_block(doc_block):
        try:
            doc_md = convert_document_to_markdown(doc_block, user_id=user_id)
            if doc_md and len(doc_md.strip()) > 30:
                return doc_md.strip()
        except Exception as e:
            logger.warning(f"[omni_analyzer] MarkItDown error for {filename}: {e}")

    # 2. Secondary PDF fallback: PyPDF text layer extraction
    if mime_type == "application/pdf" or filename.lower().endswith(".pdf"):
        try:
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
            pages_text = []
            for idx, page in enumerate(reader.pages):
                txt = page.extract_text()
                if txt and txt.strip():
                    pages_text.append(f"### Page {idx + 1}\n\n{txt.strip()}")
            if pages_text:
                full_pdf_text = "\n\n---\n\n".join(pages_text)
                if len(full_pdf_text.strip()) > 30:
                    return f"[Document: '{filename}' | Format: PDF (PyPDF Extraction)]\n\n{full_pdf_text}"
        except Exception as pypdf_err:
            logger.warning(f"[omni_analyzer] PyPDF fallback failed for {filename}: {pypdf_err}")

    # 3. Secondary HTML / Webpage fallback: BeautifulSoup article extraction
    if "html" in mime_type or filename.lower().endswith((".html", ".htm")):
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(raw_bytes, "html.parser")
            # Remove scripts, styles, nav, footer
            for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "svg"]):
                tag.decompose()
            
            # Find main article or body
            main_node = soup.find("article") or soup.find("main") or soup.find("body") or soup
            extracted_html_text = main_node.get_text(separator="\n\n", strip=True)
            if extracted_html_text and len(extracted_html_text) > 30:
                title = soup.title.string.strip() if soup.title and soup.title.string else filename
                return f"[Web Document: '{title}' | URL: {file_url}]\n\n{extracted_html_text}"
        except Exception as bs_err:
            logger.warning(f"[omni_analyzer] BeautifulSoup fallback failed for {filename}: {bs_err}")

    # 4. Plain text / CSV / JSON fallback
    if mime_type.startswith("text/") or filename.lower().endswith((".txt", ".csv", ".json", ".xml", ".md", ".tsv")):
        try:
            decoded = raw_bytes.decode("utf-8", errors="replace").strip()
            if decoded and len(decoded) > 10:
                return f"[Document: '{filename}' | Format: Plain Text]\n\n{decoded}"
        except Exception:
            pass

    # No text layer found (scanned image PDF, photo, audio, video) -> Proceed to Tier 2 Multimodal Omni
    return None


def _analyze_single_file(file_source: str, query: str, config: Optional[RunnableConfig] = None) -> str:
    """Universal file & document analysis tool — analyze any document, image, audio, video, or URL.

    Features:
    - Tier 1: Fast, lossless structured Markdown conversion for documents (PDF, Word, Excel, PowerPoint, CSV, HTML, TXT, EPUB).
    - Tier 2: Seamless Multimodal Omni Vision/Audio fallback for scanned image PDFs, photos, diagrams, audio transcripts, and video inspection.
    - Works with public URLs (including Google Docs/Drive, Dropbox, GitHub, websites), chat attachments, or workspace files.

    Args:
        file_source: File name from chat history, workspace file path, or ANY public URL (http/https) to analyze (e.g. 'report.pdf', 'https://example.com/data.xlsx', 'https://docs.google.com/document/d/...', 'diagram.png', 'voice.mp3').
        query: Specific question, instructions, or analysis required (e.g. 'Summarize the executive summary', 'What are the total revenues in Q3 table?', 'Describe what is shown in this chart', 'Extract all key points').

    Returns:
        Comprehensive, accurate analysis answering the query based on the document content.
    """
    print(f"[omni_analyzer] Tool called for source: '{file_source}', query: '{query}'")
    lower_source = file_source.strip().lower()

    configurable = config.get("configurable", {}) if config else {}
    user_id = configurable.get("user_id")
    if user_id:
        active_user_id.set(user_id)

    # 1. Resolve file source (URL, Workspace file, or Chat Attachment)
    is_http_url = lower_source.startswith(('http://', 'https://'))
    is_data_uri = lower_source.startswith('data:')
    file_url = None
    filename = file_source.strip()

    if is_http_url:
        normalized_url, resolved_name = _normalize_document_url(file_source.strip())
        file_url = normalized_url
        filename = resolved_name
        print(f"[omni_analyzer] Direct URL resolved: {filename} ({file_url})")
    elif is_data_uri:
        file_url = file_source.strip()
        filename = "attachment_data"
        print(f"[omni_analyzer] Direct Data URI provided: {filename}")
    else:
        # Unified resolution: thread workspace (output/threads/<id>/) first,
        # then the portable thread_files registry (R2/Supabase URL) so files
        # generated on another machine/deployment still resolve.
        from research_agent import storage_service
        thread_id = configurable.get("thread_id")
        resolved, resolved_name = storage_service.resolve_file_source(
            file_source, thread_id=thread_id, user_id=user_id
        )
        if resolved:
            file_url = resolved
            filename = resolved_name
            print(f"[omni_analyzer] Resolved file source: {filename} ({file_url})")

    # Search conversation history in Supabase if not a direct URL/file
    if not file_url:
        thread_id = configurable.get("thread_id")
        if not thread_id:
            return "❌ Error: Thread ID missing in configuration to lookup conversation attachments."

        try:
            session_uuid = str(uuid.UUID(thread_id))
        except ValueError:
            session_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, thread_id))

        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")

        if supabase_url and supabase_key:
            try:
                from supabase import create_client, ClientOptions
                opts = ClientOptions(postgrest_client_timeout=30, storage_client_timeout=30)
                client = create_client(supabase_url, supabase_key, options=opts)
                res = client.table("messages").select("content, created_at").eq("session_id", session_uuid).order("created_at", desc=True).limit(25).execute()
                messages_data = res.data or []

                doc_regex = r'https?://[a-zA-Z0-9\-\.]+(?:\.supabase\.co/storage/v1/object/public/[^\s"\'<>]+|/[^\s"\'<>]+\.(?:png|jpg|jpeg|webp|gif|pdf|mp3|wav|mp4|mov|doc|docx|ppt|pptx|xls|xlsx|csv|txt|epub|html))'

                for msg in messages_data:
                    content = str(msg.get("content", ""))
                    if file_source.lower() in content.lower():
                        urls = re.findall(doc_regex, content)
                        for u in urls:
                            if file_source.lower() in u.lower() or file_source.split(".")[0].lower() in u.lower():
                                file_url = u
                                filename = os.path.basename(u.split("?")[0]) or filename
                                break
                        if file_url:
                            break

                if not file_url and any(k in lower_source for k in ["pic", "photo", "image", "file", "attachment", "upload", "doc", "video", "audio", "ppt", "presentation", "sheet", "pdf"]):
                    for msg in messages_data:
                        content = str(msg.get("content", ""))
                        urls = re.findall(doc_regex, content)
                        if urls:
                            file_url = urls[0]
                            filename = os.path.basename(file_url.split("?")[0]) or "attachment"
                            print(f"[omni_analyzer] Resolved generic '{file_source}' to most recent attachment: {file_url}")
                            break
            except Exception as db_err:
                logger.warning(f"[omni_analyzer] DB attachment lookup warning: {db_err}")

    if not file_url:
        return f"❌ Error: Could not find or access '{file_source}'. Please provide a valid URL (http/https), a file path in your workspace, or upload the file to chat."

    # 2. Download / Read File Content
    raw_bytes = b""
    base64_data = ""
    mime_type = ""

    try:
        if file_url.startswith("data:"):
            header, b64_part = file_url.split(";base64,") if ";base64," in file_url else ("", file_url.split(",")[-1])
            missing_pad = len(b64_part) % 4
            if missing_pad:
                b64_part += '=' * (4 - missing_pad)
            raw_bytes = base64.b64decode(b64_part)
            base64_data = b64_part
            mime_type = header.replace("data:", "") if header else "application/octet-stream"
        elif file_url.startswith(("http://", "https://")):
            print(f"[omni_analyzer] Downloading file: {file_url}")
            header_mime = ""
            try:
                with httpx.Client(follow_redirects=True, timeout=40.0, headers=_BROWSER_HEADERS) as http_client:
                    resp = http_client.get(file_url)
                    resp.raise_for_status()
                    raw_bytes = resp.content
                    header_mime = resp.headers.get("content-type", "")
            except Exception as httpx_err:
                print(f"[omni_analyzer] Primary httpx download encountered: {httpx_err}. Retrying via urllib engine...")
                import urllib.request
                req = urllib.request.Request(file_url, headers=_BROWSER_HEADERS)
                with urllib.request.urlopen(req, timeout=40.0) as u_resp:
                    raw_bytes = u_resp.read()
                    header_mime = u_resp.headers.get("Content-Type", "")

            mime_type = _detect_mime_type(filename, raw_bytes, header_mime)
            base64_data = base64.b64encode(raw_bytes).decode("utf-8")
        elif os.path.exists(file_url):
            with open(file_url, "rb") as f:
                raw_bytes = f.read()
            mime_type = _detect_mime_type(filename, raw_bytes)
            base64_data = base64.b64encode(raw_bytes).decode("utf-8")
    except Exception as fetch_err:
        print(f"[omni_analyzer] Failed to read/download '{filename}': {fetch_err}")
        return f"❌ Error: Failed to download or read '{filename}'. Detail: {fetch_err}"

    if not raw_bytes:
        return f"❌ Error: File '{filename}' was empty (0 bytes received)."

    # 3. Tier 1: Extract Document Text & Structure via MarkItDown
    doc_markdown = _extract_text_layer(raw_bytes, filename, mime_type, file_url, user_id=user_id)

    # 4. Configure Omni Model & Provider
    from research_agent.tools.provider_engine import _fetch_settings_from_supabase, get_settings
    settings = _fetch_settings_from_supabase(user_id) or get_settings(user_id)
    omni_provider = settings.get("omni_provider", "gemini").strip().lower()
    omni_model = settings.get("omni_model", "gemini-3.1-flash-lite").strip()

    # Build Prompt Instruction
    if doc_markdown:
        instruction = (
            f"You are analyzing the document: '{filename}'\n"
            f"Source Location: {file_url}\n\n"
            f"DOCUMENT CONTENT (Parsed via MarkItDown Engine):\n"
            f"\"\"\"\n{doc_markdown}\n\"\"\"\n\n"
            f"User Query: {query}\n\n"
            f"Please answer the user's query thoroughly, precisely, and cite relevant sections or data points from the document."
        )
    else:
        instruction = (
            f"You are analyzing the file: '{filename}' (MIME type: {mime_type})\n"
            f"Source Location: {file_url}\n\n"
            f"User Query: {query}\n\n"
            f"Perform an in-depth visual, OCR, and multi-modal analysis of the attached content to answer the user's query precisely."
        )

    # 5. Execute Analysis via Gemini (Direct Multimodal SDK)
    if omni_provider == "gemini":
        gemini_key = get_user_api_key("gemini_client_api_key", user_id=user_id) or os.environ.get("GEMINI_API_KEY", "")
        if not gemini_key:
            return "❌ Error: gemini_client_api_key / GEMINI_API_KEY is not set in settings or environment."

        try:
            from google import genai
            from google.genai import types

            print(f"[omni_analyzer] Running Gemini Omni analysis on '{filename}' (model: {omni_model}, structured_markdown={bool(doc_markdown)})...")
            client = genai.Client(api_key=gemini_key)
            model_id = omni_model.split("/")[-1] if "/" in omni_model else omni_model

            if doc_markdown:
                # Text-only direct instruction for fast token-efficient processing
                parts = [types.Part.from_text(text=instruction)]
            else:
                # Tier 2: Multimodal binary parts (Images, Scanned PDF OCR, Audio, Video)
                parts = [
                    types.Part.from_text(text=instruction),
                    types.Part.from_bytes(data=raw_bytes, mime_type=mime_type),
                ]

            contents = [types.Content(role="user", parts=parts)]
            response = client.models.generate_content(
                model=model_id,
                contents=contents,
            )
            print(f"[omni_analyzer] Gemini Omni analysis completed successfully.")
            return response.text.strip()
        except Exception as gemini_err:
            print(f"[omni_analyzer] Direct Gemini call failed: {gemini_err}")
            return f"❌ Error: Gemini Omni analysis failed: {gemini_err}"

    # 6. Execute Analysis via Standard OpenAI/OpenRouter Multimodal Gateway
    else:
        actual_provider = omni_provider if omni_provider in get_all_provider_names() else "openrouter"
        gateway_base = get_provider_base_url(actual_provider)
        cfg = get_provider_config(actual_provider)
        if cfg and "base_url_env" in cfg and not gateway_base.endswith("/v1"):
            gateway_base = gateway_base + "/v1"

        agent_settings_key = cfg.get("agent_settings_key", "") if cfg else ""
        api_key = get_user_api_key(agent_settings_key, user_id=user_id) if agent_settings_key else get_provider_api_key(actual_provider)
        if not api_key:
            return f"❌ Error: API key config missing in user settings for provider '{actual_provider}'."

        content_parts = [{"type": "text", "text": instruction}]

        if not doc_markdown:
            # Attach base64 data for visual/audio inspection
            if mime_type.startswith("image/"):
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{base64_data}"}
                })
            elif mime_type.startswith("audio/"):
                content_parts.append({
                    "type": "input_audio",
                    "input_audio": {
                        "data": base64_data,
                        "format": "mp3" if "mp3" in mime_type else "wav"
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
            "max_tokens": 3000,
        }

        try:
            print(f"[omni_analyzer] Running Omni analysis on '{filename}' via {actual_provider} ({omni_model})...")
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
            print(f"[omni_analyzer] Omni analysis completed successfully.")
            return raw_response
        except Exception as llm_err:
            print(f"[omni_analyzer] LLM analysis call failed: {llm_err}")
            return f"❌ Error: Failed to analyze '{filename}' using {actual_provider}: {llm_err}"

def _infer_source_media_type(source: str) -> Tuple[str, str]:
    """Infer (media_type, mime_type) from URL, filename, or data URI."""
    source_clean = source.strip().lower()

    if source_clean.startswith("data:"):
        header = source_clean.split(";")[0].replace("data:", "")
        if header.startswith("image/"):
            return "image", header
        if header.startswith("video/"):
            return "video", header
        if header.startswith("audio/"):
            return "audio", header
        if header == "application/pdf" or "pdf" in header:
            return "document", "application/pdf"
        return "document", header

    path_part = source_clean.split("?")[0].rstrip("/")
    ext = os.path.splitext(path_part)[1]

    if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".tiff"):
        mime = "image/png" if ext == ".png" else "image/webp" if ext == ".webp" else "image/jpeg"
        return "image", mime
    if ext in (".mp4", ".webm", ".mov", ".avi", ".mkv"):
        return "video", f"video/{ext.lstrip('.')}"
    if ext in (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"):
        return "audio", f"audio/{ext.lstrip('.')}"
    if ext == ".pdf":
        return "document", "application/pdf"
    if ext in (".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".csv", ".txt", ".md", ".html"):
        return "document", "text/plain"

    if any(hint in source_clean for hint in ["/photo-", "/image", "format=jpg", "format=png", "format=webp", "img_url"]):
        return "image", "image/jpeg"

    return "unknown", "application/octet-stream"

@tool(parse_docstring=True)
def omni_analyzer(
    file_sources: List[str],
    query: str,
    agent_id: Optional[str] = None,
    config: Optional[RunnableConfig] = None,
) -> str:
    """Analyze one or more files, URLs, or brand assets with capability-aware routing.

    Supported inputs:
    - Public URLs (images, videos, audio, documents, web pages)
    - Workspace file names or paths
    - Brand asset keys or labels attached to the current agent

    Consistent Treatment:
    - If the current model natively supports the asset modality (e.g. vision for images),
      the asset is routed directly into the agent's context for native inspection.
    - If the current model lacks native support (or for complex documents/text extraction),
      it is analyzed by Omni and returned as structured text.

    Args:
        file_sources: One or more file names, URLs, asset keys, or asset labels to inspect.
        query: The question or inspection instruction to apply to every selected file.
        agent_id: Optional agent ID filter — if provided, inspects brand assets attached to this agent.
        config: LangChain runtime configuration.

    Returns:
        A combined analysis, plus a direct-context marker when supported assets should be
        attached to the next model request by the runtime.
    """
    if isinstance(file_sources, str):
        file_sources = [file_sources]
    if not file_sources:
        return "❌ Error: file_sources is empty."

    if len(file_sources) > 8:
        return (
            f"❌ Error: Too many files selected ({len(file_sources)}). "
            "Maximum allowed is 8 assets per inspection call. Please select up to 8 assets."
        )

    configurable = config.get("configurable", {}) if config else {}
    if not agent_id:
        agent_id = configurable.get("agent_id")
    user_id = configurable.get("user_id")

    if not agent_id:
        results = []
        for source in file_sources:
            results.append(f"### {source}\n{_analyze_single_file(source, query, config)}")
        return "\n\n".join(results)

    agent_assets = get_agent_brand_assets(agent_id)
    selected, missing = resolve_selected_assets(file_sources, agent_assets)
    caps = get_agent_capabilities(agent_id, user_id=user_id)

    direct_assets = [asset for asset in selected if asset_supports_direct_context(asset, caps)]
    omni_assets = [asset for asset in selected if not asset_supports_direct_context(asset, caps)]

    sections = []

    if omni_assets:
        for asset in omni_assets:
            source = asset.get("resolved_url") or asset.get("asset_key") or asset.get("label")
            analysis = _analyze_single_file(source, query, config)
            sections.append(f"### {asset.get('label') or asset.get('asset_key')}\n{analysis}")

    for source in missing:
        is_url = source.startswith(("http://", "https://", "ftp://"))
        is_data = source.startswith("data:")
        is_file = os.path.exists(source)

        if is_url or is_data or is_file:
            media_type, mime_type = _infer_source_media_type(source)
            external_asset = {
                "asset_key": source,
                "label": os.path.basename(source.split("?")[0]) or source,
                "media_type": media_type,
                "mime_type": mime_type,
                "resolved_media_type": media_type,
                "resolved_url": source,
            }
            if asset_supports_direct_context(external_asset, caps):
                direct_assets.append(external_asset)
            else:
                analysis = _analyze_single_file(source, query, config)
                sections.append(f"### {source}\n{analysis}")
        else:
            # Reject brand asset not attached to this agent
            sections.append(
                f"### {source}\n❌ Access Denied: Asset '{source}' is not attached to this agent. "
                "Only brand assets in folders attached to this agent can be inspected."
            )

    if direct_assets:
        direct_summary = (
            "Direct context assets (attached by the runtime):\n"
            + "\n".join(f"- {asset.get('label') or asset.get('asset_key')}" for asset in direct_assets)
        )
        sections.insert(0, direct_summary)
        sections.append(build_direct_context_payload(query, direct_assets))

    return "\n\n".join(sections)
