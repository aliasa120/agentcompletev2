import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    
    # 1. Create a thread
    thread = await client.threads.create()
    thread_id = thread["thread_id"]
    print(f"Created thread: {thread_id}")
    
    # Get workflows to find a valid workflow_id if needed
    # (or just use a dummy one since fallback will run if not found)
    # Let's list assistants
    assistants = await client.assistants.search()
    assistant_id = assistants[0]["assistant_id"] if assistants else "research"
    print(f"Using assistant: {assistant_id}")
    
    # 2. Create a background run
    # Use fallback node (no workflow_id config needed)
    run = await client.runs.create(
        thread_id,
        assistant_id,
        input={"messages": [{"role": "user", "content": "Tell me a very short 1-sentence joke."}]}
    )
    run_id = run["run_id"]
    print(f"Started run: {run_id} | Status: {run['status']}")
    
    # 3. Immediately join the stream
    print("Joining stream...")
    try:
        async for chunk in client.runs.join_stream(
            thread_id,
            run_id,
            # Let's specify stream modes
            stream_mode=["values", "updates", "messages-tuple"]
        ):
            print(f"Chunk received: {chunk}")
    except Exception as e:
        print("Error during join_stream:", e)

if __name__ == "__main__":
    asyncio.run(main())
