import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    thread_id = "eeff6230-830b-46d4-bbfc-87c8d8d07d22"
    
    state = await client.threads.get_state(thread_id)
    print("Next nodes:", state.get("next"))
    print("Interrupts:", state.get("interrupts"))
    values = state.get("values", {})
    print("Keys in values:", values.keys())
    messages = values.get("messages", [])
    print("Messages count:", len(messages))
    for i, msg in enumerate(messages):
        print(f"Message {i}: type={msg.get('type')}, content={repr(msg.get('content')[:200] if msg.get('content') else '')}")

if __name__ == "__main__":
    asyncio.run(main())
