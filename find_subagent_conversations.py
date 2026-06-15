import json

def main():
    log_path = r"C:\Users\kashif\.gemini\antigravity-ide\brain\4561306d-15e5-429c-b1d7-7521d6be7b3e\.system_generated\logs\transcript.jsonl"
    
    with open(log_path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                step = json.loads(line)
                tool_calls = step.get("tool_calls", [])
                for tc in tool_calls:
                    name = tc.get("name")
                    if name:
                        print(f"Step {step.get('step_index')}: {name}")
                        if "logs" in name or "console" in name or "capture" in name:
                            print(f"  Args: {tc.get('args')}")
            except Exception as e:
                pass

if __name__ == "__main__":
    main()
