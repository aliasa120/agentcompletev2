import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    # Let's inspect the most recent thread
    threads = await client.threads.search(limit=1)
    if not threads:
        print("No threads found")
        return
    thread_id = threads[0]["thread_id"]
    print(f"=== HISTORY FOR THREAD {thread_id} ===")
    
    history = await client.threads.get_history(thread_id)
    for idx, item in enumerate(history):
        print(f"\nStep {idx}: Checkpoint ID: {item.get('checkpoint_id')}")
        print(f"  Next: {item.get('next')}")
        print(f"  Metadata: {item.get('metadata')}")
        values = item.get("values", {})
        messages = values.get("messages", [])
        print(f"  Messages Count: {len(messages)}")
        for m in messages[-2:]:
            print(f"    Message: type={m.get('type')}, content={repr(m.get('content')[:150] if m.get('content') else '')}")

if __name__ == "__main__":
    asyncio.run(main())
