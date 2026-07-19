import os
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

_mem0_clients: Dict[str, Any] = {}

def get_mem0_client(user_id: Optional[str] = None) -> Optional[Any]:
    """Lazy initialize and return the Mem0 Memory client using Supabase settings."""
    global _mem0_clients
    
    from .provider_engine import active_user_id, get_settings, get_llm_config, get_user_api_key
    uid = user_id or active_user_id.get()
    uid_str = str(uid) if uid else "default"
    
    if uid_str in _mem0_clients:
        return _mem0_clients[uid_str]

    try:
        from mem0 import Memory
        from langchain_pinecone import PineconeEmbeddings
    except ImportError as e:
        logger.warning(f"Mem0 or langchain-pinecone not installed. Error: {e}")
        return None

    # Resolve settings for the active user
    settings = get_settings(uid)

    # Check if Mem0 is enabled
    mem0_enabled = settings.get("mem0_enabled", "false").lower() == "true"
    if not mem0_enabled:
        return None

    # Get Pinecone key — per-user from agent_settings, fallback to env
    pinecone_api_key = get_user_api_key("pinecone_api_key", "PINECONE_API_KEY", uid)
    if not pinecone_api_key:
        logger.warning("MEM0_ENABLED is true but pinecone_api_key is not set in user settings or PINECONE_API_KEY env.")
        return None

    # Get Pinecone Index Name — per-user from agent_settings, fallback to 'memories'
    pinecone_index_name = settings.get("pinecone_index_name", "").strip() or "memories"

    # Clean up placeholder env keys to prevent Mem0 / LiteLLM from attempting to use them
    for k, v in list(os.environ.items()):
        if isinstance(v, str) and ("your_" in v.lower() or v.lower().endswith("_here")):
            os.environ.pop(k, None)

    # Get LLM configuration via unified provider_engine resolver (user-scoped)
    provider = settings.get("mem0_extraction_provider", "openrouter").strip().lower()
    base_url, api_key, model = get_llm_config("mem0_extraction", uid)

    if not api_key:
        logger.warning("Mem0 LLM provider API key is missing.")
        return None

    # Setup embeddings
    try:
        embeddings = PineconeEmbeddings(
            model="multilingual-e5-large",
            pinecone_api_key=pinecone_api_key
        )
    except Exception as e:
        logger.error(f"Failed to initialize PineconeEmbeddings: {e}")
        return None

    # Determine llm provider name for Mem0 (use "openai" for compatible providers)
    llm_provider = "openai"
    if provider == "anthropic":
        llm_provider = "anthropic"

    config = {
        "vector_store": {
            "provider": "pinecone",
            "config": {
                "collection_name": pinecone_index_name,  # Pinecone index name
                "embedding_model_dims": 1024,  # dimensions for multilingual-e5-large
                "api_key": pinecone_api_key,
                "serverless_config": {
                    "cloud": "aws",
                    "region": "us-east-1"
                }
            }
        },
        "embedder": {
            "provider": "langchain",
            "config": {
                "model": embeddings,
            }
        },
        "llm": {
            "provider": llm_provider,
            "config": {
                "model": model,
                "api_key": api_key,
                "openai_base_url": base_url,
                "temperature": 0.0,
            }
        },
        "custom_instructions": "Ignore all casual greetings, formatting instructions, small talk, and meta-dialogue. Only extract hard facts, user preferences, configuration parameters, or concrete constraints. Extract them as short, atomic, single-fact sentences (e.g., separate name, location, and job into individual sentences) to prevent compound facts."
    }

    # Setup Cohere reranker if key is available — per-user from agent_settings, fallback to env
    cohere_api_key = get_user_api_key("cohere_api_key", "COHERE_API_KEY", uid)
    if cohere_api_key:
        config["reranker"] = {
            "provider": "cohere",
            "config": {
                "model": "rerank-v4.0-pro",
                "api_key": cohere_api_key,
                "top_k": 10
            }
        }

    # Monkeypatch Mem0's entity collection naming function to use hyphens for Pinecone
    try:
        import mem0.memory.main
        def patched_entity_collection_name(provider: str, collection_name: str) -> str:
            separator = "-" if provider in ("s3_vectors", "pinecone") else "_"
            return f"{collection_name}{separator}entities"
        mem0.memory.main._entity_collection_name = patched_entity_collection_name
    except Exception as me:
        logger.warning(f"Failed to monkeypatch Mem0 entity collection name function: {me}")

    try:
        client = Memory.from_config(config)
        _mem0_clients[uid_str] = client
        logger.info(f"Mem0 client initialized successfully for user {uid_str} with Pinecone and Cohere Reranker.")
        return client
    except Exception as e:
        logger.error(f"Failed to create Mem0 client from config for user {uid_str}: {e}")
        return None
