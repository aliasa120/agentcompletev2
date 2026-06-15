import asyncio
from langgraph_sdk import get_client

async def main():
    client = get_client(url="http://localhost:2024")
    print("Methods of client.runs:", [m for m in dir(client.runs) if not m.startswith("_")])
    print("\nMethods of client.threads:", [m for m in dir(client.threads) if not m.startswith("_")])

if __name__ == "__main__":
    asyncio.run(main())
