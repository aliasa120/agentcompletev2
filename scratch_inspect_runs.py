import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    threads = await client.threads.search(limit=10)
    print("=== DETAILED THREADS & RUNS ===")
    for t in threads:
        thread_id = t["thread_id"]
        status = t["status"]
        print(f"\nThread ID: {thread_id} | Status: {status} | Metadata: {t.get('metadata')}")
        
        runs = await client.runs.list(thread_id)
        for r in runs:
            print(f"  Run ID: {r['run_id']}")
            print(f"    Status: {r['status']}")
            print(f"    Assistant: {r['assistant_id']}")
            print(f"    Created: {r['created_at']}")
            print(f"    Updated: {r['updated_at']}")
            print(f"    Metadata: {r.get('metadata')}")
            
            try:
                state = await client.threads.get_state(thread_id)
                print(f"    State Next: {state.get('next')}")
                print(f"    State Interrupts: {state.get('interrupts')}")
            except Exception as e:
                print(f"    Failed to get state: {e}")

if __name__ == "__main__":
    asyncio.run(main())
