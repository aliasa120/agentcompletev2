import os
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

_mem0_client = None

def get_mem0_client() -> Optional[Any]:
    """Lazy initialize and return the Mem0 Memory client using Supabase settings."""
    global _mem0_client
    if _mem0_client is not None:
        return _mem0_client

    try:
        from mem0 import Memory
        from langchain_pinecone import PineconeEmbeddings
    except ImportError as e:
        logger.warning(f"Mem0 or langchain-pinecone not installed. Error: {e}")
        return None

    # Resolve settings
    from .provider_engine import get_settings
    settings = get_settings()

    # Check if Mem0 is enabled
    mem0_enabled = settings.get("mem0_enabled", "false").lower() == "true"
    if not mem0_enabled:
        return None

    # Get Pinecone key
    pinecone_api_key = os.environ.get("PINECONE_API_KEY", "").strip()
    if not pinecone_api_key:
        logger.warning("MEM0_ENABLED is true but PINECONE_API_KEY is not set.")
        return None

    # Clean up placeholder env keys to prevent Mem0 / LiteLLM from attempting to use them
    for k, v in list(os.environ.items()):
        if isinstance(v, str) and ("your_" in v.lower() or v.lower().endswith("_here")):
            os.environ.pop(k, None)

    # Get LLM configuration
    provider = settings.get("mem0_extraction_provider", "novita")
    model = settings.get("mem0_extraction_model", "deepseek/deepseek-v4-flash")

    # Get API key and Base URL
    from .provider_registry import get_provider_api_key, get_provider_base_url
    api_key = get_provider_api_key(provider)
    base_url = get_provider_base_url(provider)

    if not api_key:
        logger.warning(f"Mem0 LLM provider {provider} API key is missing.")
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
                "collection_name": "memories",  # Pinecone index name
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
        "custom_instructions": "Ignore all casual greetings, formatting instructions, small talk, and meta-dialogue. Only extract hard facts, user preferences, configuration parameters, or concrete constraints. Extract them as short, atomic, single-fact sentences (e.g., separate name, location, and job into individual sentences) to prevent compound facts.",
        "graph_store": {
            "provider": "none"
        }
    }

    # Setup Cohere reranker if key is available
    cohere_api_key = os.environ.get("COHERE_API_KEY", "").strip()
    if cohere_api_key:
        config["reranker"] = {
            "provider": "cohere",
            "config": {
                "model": "rerank-v4.0-pro",
                "api_key": cohere_api_key,
                "top_k": 5
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
        _mem0_client = Memory.from_config(config)
        logger.info("Mem0 client initialized successfully with Pinecone and Cohere Reranker.")
        return _mem0_client
    except Exception as e:
        logger.error(f"Failed to create Mem0 client from config: {e}")
        return None
