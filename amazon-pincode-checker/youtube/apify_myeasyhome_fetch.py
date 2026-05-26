import os, time, json
import requests
import pandas as pd

APIFY_TOKEN = os.getenv("APIFY_TOKEN") or "YOUR_APIFY_TOKEN_HERE"
ACTOR_ID = "apify/instagram-scraper"  # replace with actual actor if different
USERNAME = "myeasyhome"
MAX_POSTS = 60
APIFY_BASE = "https://api.apify.com/v2"

headers = {
    "Authorization": f"Bearer {APIFY_TOKEN}",
    "Content-Type": "application/json",
}


def start_actor():
    endpoint = f"{APIFY_BASE}/actor-tasks/{ACTOR_ID}/run-sync"
    payload = {
        "body": {
            "username": USERNAME,
            "maxPosts": MAX_POSTS,
            "includeStories": False,
            "includeFollowers": True,
            "includePrivate": False,
        }
    }

    res = requests.post(endpoint, headers=headers, json=payload, timeout=600)
    res.raise_for_status()
    return res.json()


def run():
    print("🟢 Starting Apify actor run...")
    data = start_actor()

    if not data:
        raise SystemExit("No data returned from Apify actor")

    if "output" in data:
        data = data["output"]

    # Save raw output
    with open("myeasyhome_apify_output.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print("Saved raw JSON: myeasyhome_apify_output.json")

    posts = data.get("posts", [])
    rows = []
    for p in posts:
        rows.append({
            "id": p.get("id"),
            "type": p.get("type"),
            "posted_at": p.get("createdAt"),
            "caption": p.get("caption", "").replace("\n", " "),
            "likes": p.get("likes", 0),
            "comments": p.get("comments", 0),
            "shares": p.get("shares", 0),
            "saves": p.get("saves", 0),
            "views": p.get("views", 0),
            "hashtags": ",".join(p.get("hashtags", [])),
            "engagement_rate": (p.get("likes", 0) + p.get("comments", 0)) / max(1, data.get("followers", 1)),
        })

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(by="engagement_rate", ascending=False)
        df.to_csv("myeasyhome_posts_summary.csv", index=False, encoding="utf-8-sig")
        print("Saved summary CSV: myeasyhome_posts_summary.csv")
    else:
        print("No posts found in output.")

    print("✅ Done.")


if __name__ == "__main__":
    run()
