import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    thread_id = "cd9957ec-be8d-449b-97b4-fbddd4864c05"
    
    print("=== THREAD STATE ===")
    try:
        state = await client.threads.get_state(thread_id)
        print("Keys in state:", state.keys())
        print("Checkpoint:", state.get("checkpoint"))
        print("Next nodes to execute:", state.get("next"))
        values = state.get("values", {})
        messages = values.get("messages", [])
        print(f"Number of messages: {len(messages)}")
        for i, msg in enumerate(messages):
            print(f"Message {i}: type={msg.get('type')}, role={msg.get('role')}, content={repr(msg.get('content')[:150] if msg.get('content') else '')}")
    except Exception as e:
        print("Error getting state:", e)

    print("\n=== RUNS ===")
    try:
        runs = await client.runs.list(thread_id)
        for r in runs:
            print(f"Run ID: {r['run_id']} | Status: {r['status']} | Assistant: {r['assistant_id']} | Created: {r['created_at']}")
            if r['status'] in ['running', 'error', 'failed']:
                # print error or traceback if any
                print("  Feedback:", r.get('feedback'))
                print("  Extra:", {k: v for k, v in r.items() if k in ['error', 'multitask_strategy']})
    except Exception as e:
        print("Error listing runs:", e)

if __name__ == "__main__":
    asyncio.run(main())
