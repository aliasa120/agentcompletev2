import json

def main():
    log_path = r"C:\Users\kashif\.gemini\antigravity-ide\brain\4561306d-15e5-429c-b1d7-7521d6be7b3e\.system_generated\logs\transcript.jsonl"
    
    with open(log_path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                step = json.loads(line)
                content = str(step.get("content", ""))
                # Search for console log retrieval
                if "console" in content.lower() or "error" in content.lower():
                    # Only print if it looks like console output
                    if "console_logs" in content or "console_log" in content or "loglevel" in content:
                        print(f"--- STEP {step.get('step_index')} ({step.get('type')}) ---")
                        print(content[:1000])
                        print("-" * 50)
            except Exception as e:
                pass

if __name__ == "__main__":
    main()
