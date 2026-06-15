import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    
    threads = await client.threads.search(limit=1)
    if not threads:
        print("No threads found")
        return
    thread_id = threads[0]["thread_id"]
    
    runs = await client.runs.list(thread_id)
    if not runs:
        print(f"No runs found for thread {thread_id}")
        return
    run_id = runs[0]["run_id"]
    
    print(f"=== EVENTS FOR RUN {run_id} ON THREAD {thread_id} ===")
    events = []
    async for event in client.runs.join_stream(thread_id, run_id):
        events.append(event)
        
    print(f"Total events: {len(events)}")
    for idx, e in enumerate(events):
        print(f"\nEvent {idx}: type={e.event} | Name={getattr(e, 'name', None)}")
        # Print a snippet of data
        data_str = str(e.data)
        if len(data_str) > 300:
            data_str = data_str[:300] + "..."
        print(f"  Data: {data_str}")

if __name__ == "__main__":
    asyncio.run(main())
