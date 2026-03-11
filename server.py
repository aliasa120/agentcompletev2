import subprocess
import os

def main():
    """
    Convenience server startup script.
    
    The React UI (deep-agents-ui-main) strictly requires the specific 
    LangGraph REST API endpoints (/threads, /runs, etc.). 
    Rather than rewriting these in FastAPI, this script simply launches 
    the official LangGraph open-source server to serve your agent.
    """
    print("Starting LangGraph API Server on 0.0.0.0:2024...")
    
    # Run the langgraph cli which provides a FastAPI instance behind the scenes
    cmd = ["langgraph", "dev", "--host", "0.0.0.0", "--port", "2024"]
    
    subprocess.run(cmd, check=True)

if __name__ == "__main__":
    main()
