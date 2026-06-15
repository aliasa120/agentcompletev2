import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    
    threads = await client.threads.search(limit=5)
    print("=== RECENT THREADS ===")
    for t in threads:
        thread_id = t["thread_id"]
        print(f"Thread ID: {thread_id} | Created: {t['created_at']} | Status: {t['status']}")
        
        runs = await client.runs.list(thread_id)
        for r in runs:
            print(f"  Run ID: {r['run_id']} | Status: {r['status']} | Assistant: {r['assistant_id']} | Created: {r['created_at']}")
            if r['status'] in ['error', 'failed']:
                print(f"    Error: {r.get('error')}")
                print(f"    Feedback: {r.get('feedback')}")

if __name__ == "__main__":
    asyncio.run(main())
