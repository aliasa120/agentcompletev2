import requests

site_url = "http://47.82.164.26:8000"
username = "admin"
app_password = "QX8i FF2H uGKf 6n8S 5Y5J 8FrG"
base = f"{site_url}/wp-json/wp/v2"

print("=== TEST 1: Fetch categories (read access) ===")
try:
    r = requests.get(f"{base}/categories", auth=(username, app_password), timeout=15)
    print(f"Status: {r.status_code}")
    if r.ok:
        cats = r.json()
        print(f"Categories found: {len(cats)}")
        for c in cats:
            print(f"  id={c['id']} name={c['name']} slug={c['slug']}")
    else:
        print(r.text[:300])
except Exception as e:
    print(f"ERROR: {e}")

print()
print("=== TEST 2: Create a test draft post (write access) ===")
try:
    payload = {
        "title": "TEST POST - DELETE ME",
        "content": "<p>This is a credential test post. Please delete.</p>",
        "status": "draft",
    }
    r = requests.post(f"{base}/posts", auth=(username, app_password), json=payload, timeout=30)
    print(f"Status: {r.status_code}")
    if r.status_code in (200, 201):
        data = r.json()
        post_id = data["id"]
        print(f"Post created! id={post_id} status={data['status']}")
        print(f"Edit URL: {site_url}/wp-admin/post.php?post={post_id}&action=edit")
        # Clean up
        del_r = requests.delete(f"{base}/posts/{post_id}?force=true", auth=(username, app_password), timeout=15)
        print(f"Cleanup delete status: {del_r.status_code}")
    else:
        print(r.text[:400])
except Exception as e:
    print(f"ERROR: {e}")

print()
print("=== TEST 3: Upload media (write access to media) ===")
print("Skipped (no local image to test with — auth for posts covers media too)")
