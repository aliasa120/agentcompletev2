import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    assistants = await client.assistants.search()
    for a in assistants:
        print(f"Assistant ID: {a['assistant_id']} | Name: {a.get('name')} | Config: {a.get('config')}")

if __name__ == "__main__":
    asyncio.run(main())
