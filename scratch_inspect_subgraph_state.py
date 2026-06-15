import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    
    threads = await client.threads.search(limit=5)
    for t in threads:
        thread_id = t["thread_id"]
        print(f"\n=== STATE FOR THREAD {thread_id} | Status: {t['status']} ===")
        state = await client.threads.get_state(thread_id)
        print("  Next:", state.get("next"))
        print("  Interrupts:", state.get("interrupts"))
        print("  Tasks:", state.get("tasks"))

if __name__ == "__main__":
    asyncio.run(main())
