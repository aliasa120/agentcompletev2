import inspect
import deepagents

print("deepagents path:", deepagents.__file__)
try:
    print(inspect.getsource(deepagents.create_deep_agent))
except Exception as e:
    print("Could not get source directly:", e)
    # Let's inspect deepagents directory
    import os
    pkg_dir = os.path.dirname(deepagents.__file__)
    print("Package directory contents:", os.listdir(pkg_dir))
    
    # Try finding files inside pkg_dir
    for root, dirs, files in os.walk(pkg_dir):
        for f in files:
            if f.endswith(".py"):
                print("Python file:", os.path.join(root, f))
