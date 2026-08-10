import subprocess
import os
import sys

def main():
    """
    Convenience server startup script.

    The React UI (deep-agents-ui-main) strictly requires the specific
    LangGraph REST API endpoints (/threads, /runs, etc.).
    Rather than rewriting these in FastAPI, this script simply launches
    the official LangGraph open-source server to serve your agent.

    NOTE on concurrency: the LangGraph dev server forces N_JOBS_PER_WORKER=1
    unless --n-jobs-per-worker is passed explicitly (it also overrides any
    N_JOBS_PER_WORKER set in .env). Without the flag, ALL chat runs execute
    one at a time globally, so parallel chats across windows/tabs queue up.
    """
    print("Starting LangGraph API Server on 0.0.0.0:2024...")

    # UTF-8 stdout for the CLI's unicode log output (avoids cp1252 errors on Windows)
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    # IMPORTANT: use "sys.executable -m langgraph_cli", NOT the bare "langgraph"
    # command. Without an activated venv, "langgraph" resolves to the globally
    # installed Python's copy, which then fails to load the graph (missing deps).
    cmd = [
        sys.executable, "-m", "langgraph_cli", "dev",
        "--host", "0.0.0.0",
        "--port", "2024",
        # Allow up to 10 runs in parallel (dev server default is 1!)
        # Enables parallel chats from multiple windows/tabs.
        "--n-jobs-per-worker", "10",
    ]

    subprocess.run(cmd, check=True, env=env)

if __name__ == "__main__":
    main()
