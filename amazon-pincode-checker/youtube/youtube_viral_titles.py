#!/usr/bin/env python3
"""
YouTube Viral Title Generator — Automated 5-Step Workflow

Automates the "Grow Channels" blueprint:
  Step 1: Scrape a competitor YouTube channel's videos (title + views)
  Step 2: Send data to Claude for deep title pattern analysis
  Step 3: Have Claude generate a tailored Gemini research prompt
  Step 4: Run that prompt through Gemini Deep Research
  Step 5: Feed Gemini research back to Claude → prioritised viral titles

Requirements:
  pip install playwright google-genai anthropic
  playwright install chromium

  Set environment variables:
    ANTHROPIC_API_KEY  — your Claude API key
    GEMINI_API_KEY     — your Google Gemini API key

Usage:
  # Full pipeline — scrape channel + generate titles
  python youtube_viral_titles.py --channel "https://www.youtube.com/@ChannelName"

  # Use a previously saved inventory CSV
  python youtube_viral_titles.py --inventory competitor_videos.csv

  # Just scrape (no API calls)
  python youtube_viral_titles.py --channel "https://www.youtube.com/@ChannelName" --scrape-only

  # Specify number of videos to scrape (default 100)
  python youtube_viral_titles.py --channel "https://www.youtube.com/@ChannelName" --num-videos 50

  # Custom output directory
  python youtube_viral_titles.py --channel "https://www.youtube.com/@ChannelName" --output-dir ./my_results
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path


# ---------------------------------------------------------------------------
# Retry helper for API calls
# ---------------------------------------------------------------------------

def _call_with_retry(fn, max_retries=5, base_delay=5):
    """Call fn() with exponential backoff on transient failures."""
    for attempt in range(1, max_retries + 1):
        try:
            return fn()
        except Exception as e:
            err_name = e.__class__.__name__
            is_retryable = any(k in err_name.lower() for k in ("overloaded", "rate", "timeout", "connection"))
            if not is_retryable:
                # Check error message too
                msg = str(e).lower()
                is_retryable = any(k in msg for k in ("overloaded", "529", "rate", "timeout", "503"))
            if is_retryable and attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                print(f"  ⏳ {err_name} — retrying in {delay}s (attempt {attempt}/{max_retries})...")
                time.sleep(delay)
            else:
                raise

# ---------------------------------------------------------------------------
# Step 1 — Scrape competitor channel videos
# ---------------------------------------------------------------------------

def scrape_channel_videos(channel_url: str, num_videos: int = 100, headless: bool = False) -> list[dict]:
    """
    Opens a YouTube channel in Playwright, detects whether it's a regular
    videos channel or a Shorts channel, and scrapes up to `num_videos`
    entries (title + view count).
    Returns a list of dicts: [{"title": ..., "views": ..., "views_raw": ...}, ...]
    """
    from playwright.sync_api import sync_playwright

    # Normalise URL — strip trailing slash and any existing tab path
    channel_url = channel_url.rstrip("/")
    for suffix in ("/videos", "/shorts", "/streams", "/playlists"):
        if channel_url.endswith(suffix):
            channel_url = channel_url[: -len(suffix)]
            break

    print(f"[Step 1] Scraping up to {num_videos} videos from: {channel_url}")

    videos: list[dict] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        # First try /videos tab
        page.goto(channel_url + "/videos", wait_until="networkidle", timeout=60_000)
        time.sleep(5)

        # Accept cookies dialog if it appears
        try:
            accept_btn = page.locator("button:has-text('Accept all'), button:has-text('Accept')")
            if accept_btn.count() > 0:
                accept_btn.first.click(timeout=3000)
                time.sleep(2)
        except Exception:
            pass

        # Detect channel type: regular videos or Shorts-only
        has_regular = page.locator("ytd-rich-item-renderer, ytd-grid-video-renderer").count() > 0
        has_shorts = page.locator("ytm-shorts-lockup-view-model-v2").count() > 0

        if has_regular:
            print("  Detected: Regular videos channel")
            videos = _scrape_regular_videos(page, num_videos)
        else:
            # Navigate to /shorts tab for a full grid
            print("  Detected: Shorts channel — switching to /shorts tab")
            page.goto(channel_url + "/shorts", wait_until="networkidle", timeout=60_000)
            time.sleep(5)
            videos = _scrape_shorts(page, num_videos)

        browser.close()

    print(f"[Step 1] Done — collected {len(videos)} videos.")
    return videos


def _scrape_regular_videos(page, num_videos: int) -> list[dict]:
    """Scrape standard YouTube videos from the /videos tab."""
    videos: list[dict] = []
    seen_titles: set[str] = set()
    scroll_attempts = 0
    max_scroll_attempts = 60

    while len(videos) < num_videos and scroll_attempts < max_scroll_attempts:
        items = page.query_selector_all("ytd-rich-item-renderer, ytd-grid-video-renderer")

        for item in items:
            if len(videos) >= num_videos:
                break
            try:
                title_el = item.query_selector("#video-title")
                if not title_el:
                    continue
                title = (title_el.get_attribute("title") or title_el.inner_text()).strip()
                if not title or title in seen_titles:
                    continue

                views_text = ""
                meta_items = item.query_selector_all(
                    "#metadata-line span.inline-metadata-item, "
                    "#metadata-line span.ytd-video-meta-block, "
                    "#metadata span"
                )
                for meta in meta_items:
                    txt = meta.inner_text().strip().lower()
                    if "view" in txt:
                        views_text = txt
                        break

                seen_titles.add(title)
                videos.append({
                    "title": title,
                    "views": _parse_view_count(views_text),
                    "views_raw": views_text,
                })
            except Exception:
                continue

        page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        time.sleep(1.5)
        scroll_attempts += 1

        if scroll_attempts % 10 == 0:
            print(f"  ... scraped {len(videos)}/{num_videos} videos so far (scroll {scroll_attempts})")

    return videos


def _scrape_shorts(page, num_videos: int) -> list[dict]:
    """Scrape YouTube Shorts from the /shorts tab."""
    videos: list[dict] = []
    seen_titles: set[str] = set()
    scroll_attempts = 0
    max_scroll_attempts = 80
    no_new_count = 0  # track consecutive scrolls with no new items

    while len(videos) < num_videos and scroll_attempts < max_scroll_attempts:
        prev_count = len(videos)

        # Shorts use multiple possible element types
        items = page.query_selector_all(
            "ytm-shorts-lockup-view-model-v2, "
            "ytm-shorts-lockup-view-model, "
            "ytd-rich-item-renderer, "
            "ytd-reel-item-renderer"
        )

        for item in items:
            if len(videos) >= num_videos:
                break
            try:
                # Try multiple ways to get the title
                title = ""

                # Method 1: <a title="..."> inside shorts lockup
                link = item.query_selector("a[title]")
                if link:
                    title = (link.get_attribute("title") or "").strip()

                # Method 2: #video-title element
                if not title:
                    title_el = item.query_selector("#video-title")
                    if title_el:
                        title = (title_el.get_attribute("title") or title_el.inner_text()).strip()

                # Method 3: span with role=text inside heading
                if not title:
                    heading_span = item.query_selector("h3 span[role='text']")
                    if heading_span:
                        title = heading_span.inner_text().strip()

                if not title or title in seen_titles:
                    continue

                # View count — try multiple approaches
                views_text = ""
                # Approach 1: shorts metadata subhead
                subhead = item.query_selector(
                    ".shortsLockupViewModelHostOutsideMetadataSubhead span, "
                    ".shortsLockupViewModelHostMetadataSubhead span"
                )
                if subhead:
                    views_text = subhead.inner_text().strip().lower()
                # Approach 2: aria-label on the link often has views
                if not views_text and link:
                    aria = (link.get_attribute("aria-label") or "").lower()
                    if "view" in aria:
                        import re as _re
                        m = _re.search(r"([\d,.]+[kmb]?\s*views?)", aria)
                        if m:
                            views_text = m.group(1)
                # Approach 3: any span with "views"
                if not views_text:
                    spans = item.query_selector_all("span")
                    for span in spans:
                        txt = span.inner_text().strip().lower()
                        if "view" in txt:
                            views_text = txt
                            break

                seen_titles.add(title)
                videos.append({
                    "title": title,
                    "views": _parse_view_count(views_text),
                    "views_raw": views_text,
                })
            except Exception:
                continue

        # Early exit: if no new videos found for 5 consecutive scrolls
        if len(videos) == prev_count:
            no_new_count += 1
            if no_new_count >= 5:
                print(f"  No new shorts found after {no_new_count} scrolls — channel likely has {len(videos)} total.")
                break
        else:
            no_new_count = 0

        page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        time.sleep(2)
        scroll_attempts += 1

        if scroll_attempts % 10 == 0:
            print(f"  ... scraped {len(videos)}/{num_videos} shorts so far (scroll {scroll_attempts})")

    return videos


def _parse_view_count(text: str) -> int:
    """Parse YouTube view count strings like '1.2M views', '456K views', '12,345 views'."""
    if not text:
        return 0
    text = text.lower().replace(",", "").replace(" views", "").replace(" view", "").strip()
    try:
        if "b" in text:
            return int(float(text.replace("b", "")) * 1_000_000_000)
        if "m" in text:
            return int(float(text.replace("m", "")) * 1_000_000)
        if "k" in text:
            return int(float(text.replace("k", "")) * 1_000)
        # Handle "no views" or similar
        digits = re.sub(r"[^\d]", "", text)
        return int(digits) if digits else 0
    except (ValueError, TypeError):
        return 0


def save_inventory_csv(videos: list[dict], path: Path) -> None:
    """Save scraped videos to CSV."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["title", "views", "views_raw"])
        writer.writeheader()
        writer.writerows(videos)
    print(f"[Step 1] Inventory saved to {path}")


def load_inventory_csv(path: Path) -> list[dict]:
    """Load a previously saved inventory CSV."""
    videos = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            videos.append({
                "title": row["title"],
                "views": int(row.get("views", 0)),
                "views_raw": row.get("views_raw", ""),
            })
    print(f"[Step 1] Loaded {len(videos)} videos from {path}")
    return videos


# ---------------------------------------------------------------------------
# Step 2 — Claude: Analyse title patterns
# ---------------------------------------------------------------------------

def analyse_title_patterns(videos: list[dict], channel_name: str) -> str:
    """
    Send video inventory to Claude and get a deep title-pattern analysis.
    Returns the analysis text (kept in conversation context for later steps).
    """
    import anthropic

    print(f"\n[Step 2] Sending {len(videos)} videos to Claude for title-pattern analysis...")

    # Prepare data table
    table_lines = ["Title\tViews"]
    for v in videos:
        table_lines.append(f"{v['title']}\t{v['views']:,}")
    data_table = "\n".join(table_lines)

    prompt = (
        f"Here is a complete list of video titles and view counts for the YouTube channel '{channel_name}'.\n\n"
        f"{data_table}\n\n"
        "Analyze all of it thoroughly so you become an expert at crafting video titles and topics for this channel. "
        "Act as if you are the channel owner — making video titles that go viral is critical to your success.\n\n"
        "Provide a detailed analysis covering:\n"
        "1. **Title Formats** — question-based, list-based, controversy-driven, comparison formats\n"
        "2. **Power Words** — words that appear repeatedly in high-view-count titles vs low performers\n"
        "3. **Topic Clusters** — which subject categories generate the most consistent view volume\n"
        "4. **Length Patterns** — optimal character count and word count for titles in this niche\n"
        "5. **Key Takeaways** — the top 5 actionable rules for creating viral titles in this niche"
    )

    client = anthropic.Anthropic()
    def _call():
        return client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
    response = _call_with_retry(_call)
    analysis = response.content[0].text
    print(f"[Step 2] Done — received {len(analysis):,} chars of analysis.")
    return analysis


# ---------------------------------------------------------------------------
# Step 3 — Claude: Generate Gemini research prompt
# ---------------------------------------------------------------------------

def generate_gemini_prompt(title_analysis: str, channel_name: str) -> str:
    """
    Ask Claude to craft a professional deep-research prompt for Gemini,
    tailored to the niche based on the title analysis.
    """
    import anthropic

    print(f"\n[Step 3] Asking Claude to generate a Gemini Deep Research prompt...")

    messages = [
        {
            "role": "user",
            "content": (
                f"You previously analysed the video titles and performance data for the YouTube channel '{channel_name}'. "
                f"Here is your analysis:\n\n{title_analysis}\n\n"
                "Now create the perfect prompt for Gemini to conduct deep research on this niche, "
                "so it can identify trending topics. I'll then send you that research so you can use it "
                "to come up with viral video topics for me.\n\n"
                "The prompt should cover:\n"
                "1. Trending topics right now\n"
                "2. Top performing video formats\n"
                "3. Emerging & upcoming subjects generating buzz\n"
                "4. High-search-volume keywords\n"
                "5. Audience pain points & desires\n"
                "6. Competitor channel analysis\n"
                "7. Seasonal & event-based opportunities\n"
                "8. Underserved topics with demand\n\n"
                "Output ONLY the prompt text — nothing else."
            ),
        }
    ]

    client = anthropic.Anthropic()
    def _call():
        return client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            messages=messages,
        )
    response = _call_with_retry(_call)
    gemini_prompt = response.content[0].text
    print(f"[Step 3] Done — generated {len(gemini_prompt):,}-char research prompt.")
    return gemini_prompt


# ---------------------------------------------------------------------------
# Step 4 — Gemini Deep Research
# ---------------------------------------------------------------------------

def run_gemini_research(gemini_prompt: str) -> str:
    """
    Send the research prompt to Google Gemini and get a comprehensive
    niche intelligence report. Falls back to Claude if Gemini quota is exhausted.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        try:
            from google import genai

            print(f"\n[Step 4] Sending research prompt to Gemini...")
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model="gemini-2.0-flash",
                contents=gemini_prompt,
                config=genai.types.GenerateContentConfig(
                    max_output_tokens=8192,
                    temperature=0.7,
                ),
            )
            research = response.text
            print(f"[Step 4] Done — received {len(research):,} chars of research from Gemini.")
            return research
        except Exception as e:
            print(f"[Step 4] Gemini failed ({e.__class__.__name__}), falling back to Claude...")

    return _run_claude_research(gemini_prompt)


def _run_claude_research(research_prompt: str) -> str:
    """Fallback: use Claude to perform the trend research instead of Gemini."""
    import anthropic

    print(f"[Step 4] Using Claude for trend research (Gemini fallback)...")
    client = anthropic.Anthropic()
    def _call():
        return client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=8192,
            messages=[{
                "role": "user",
                "content": (
                    "You are a YouTube trend research analyst. Conduct thorough research and provide "
                    "detailed, actionable intelligence based on the following research brief. "
                    "Draw on your knowledge of current YouTube trends, search patterns, and audience behavior.\n\n"
                    f"{research_prompt}"
                ),
            }],
        )
    response = _call_with_retry(_call)
    research = response.content[0].text
    print(f"[Step 4] Done — received {len(research):,} chars of research from Claude.")
    return research


# ---------------------------------------------------------------------------
# Step 5 — Claude: Generate viral titles
# ---------------------------------------------------------------------------

def generate_viral_titles(
    title_analysis: str,
    gemini_research: str,
    channel_name: str,
) -> str:
    """
    Feed the Gemini research back to Claude along with the earlier title
    analysis. Claude cross-references everything and produces a prioritised
    list of viral video titles organised by urgency.
    """
    import anthropic

    print(f"\n[Step 5] Asking Claude to generate viral titles...")

    prompt = (
        f"You previously analysed the video titles and performance data for '{channel_name}'. "
        f"Here is your original analysis:\n\n{title_analysis}\n\n"
        f"---\n\n"
        f"Here is fresh research from Gemini on what's currently trending in this niche:\n\n"
        f"{gemini_research}\n\n"
        f"---\n\n"
        "Take all of this information and cross-reference it with the proven title formulas and "
        "patterns you identified earlier. Create a prioritized list of viral video topics and titles, "
        "organized by urgency:\n\n"
        "1. **🔥 PUBLISH WITHIN 48 HOURS** — Hot trend titles for topics spiking right now\n"
        "2. **📅 THIS WEEK** — Rising topic titles with strong momentum\n"
        "3. **📆 THIS MONTH** — Emerging opportunity titles building over the next 30 days\n\n"
        "For each title, include:\n"
        "- The title itself\n"
        "- Which trending topic/opportunity it targets\n"
        "- Which proven title pattern it uses (from your analysis)\n"
        "- Estimated viral potential (High / Medium)\n\n"
        "Generate at least 20 titles total across all tiers."
    )

    client = anthropic.Anthropic()
    def _call():
        return client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=8192,
            messages=[{"role": "user", "content": prompt}],
        )
    response = _call_with_retry(_call)
    titles_output = response.content[0].text
    print(f"[Step 5] Done — generated {len(titles_output):,} chars of title recommendations.")
    return titles_output


# ---------------------------------------------------------------------------
# Step 6 — Claude: Generate video scripts
# ---------------------------------------------------------------------------

def generate_scripts(
    titles_output: str,
    title_analysis: str,
    channel_name: str,
) -> str:
    """
    Take the viral title list and generate a ready-to-produce script for
    each title. Scripts are formatted for YouTube Shorts (under 60 seconds)
    with hook, body, and CTA structure.
    """
    import anthropic

    print(f"\n[Step 6] Generating video scripts for all titles...")

    prompt = (
        f"You are a YouTube Shorts scriptwriter for the channel '{channel_name}'.\n\n"
        f"Here is the title analysis showing what works for this channel:\n{title_analysis}\n\n"
        f"---\n\n"
        f"Here are the viral video titles that were generated:\n{titles_output}\n\n"
        f"---\n\n"
        "For EACH title listed above, write a complete YouTube Shorts script (under 60 seconds when spoken).\n\n"
        "Each script MUST follow this structure:\n\n"
        "## [Title]\n\n"
        "**Hook (0-3 sec):** A punchy opening line that stops the scroll. Use curiosity, shock, or a bold claim.\n\n"
        "**Visual:** Brief description of what should be shown on screen during the hook.\n\n"
        "**Body (3-45 sec):** The main content — narrate the build process, transformation, or reveal. "
        "Use short, punchy sentences. Include 3-5 scene descriptions with matching voiceover lines.\n\n"
        "**Climax/Reveal (45-55 sec):** The big payoff moment — the finished build, the hidden room reveal, etc.\n\n"
        "**CTA (55-60 sec):** End with a question or hook to drive comments and engagement.\n\n"
        "---\n\n"
        "Additional rules:\n"
        "- Keep the tone casual, excited, and visual\n"
        "- Match the channel's style: first-person, action-driven, satisfying reveals\n"
        "- Each script should be self-contained and ready to hand to an editor\n"
        "- Include [SFX] tags for sound effects where appropriate\n"
        "- Total word count per script: 100-150 words (fits 60 seconds of narration)\n"
        "- Generate scripts for ALL titles — do not skip any"
    )

    client = anthropic.Anthropic()
    def _call():
        return client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=16384,
            messages=[{"role": "user", "content": prompt}],
        )
    response = _call_with_retry(_call)
    scripts = response.content[0].text
    print(f"[Step 6] Done — generated {len(scripts):,} chars of scripts.")
    return scripts


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def _extract_channel_name(url: str) -> str:
    """Guess a channel name from the URL for display purposes."""
    # Handle @handle format
    match = re.search(r"@([\w\-]+)", url)
    if match:
        return match.group(1)
    # Handle /c/ChannelName or /channel/ID
    match = re.search(r"/(?:c|channel|user)/([\w\-]+)", url)
    if match:
        return match.group(1)
    return "UnknownChannel"


def run_pipeline(
    channel_url: str | None = None,
    inventory_path: str | None = None,
    num_videos: int = 100,
    output_dir: str = ".",
    scrape_only: bool = False,
    headless: bool = False,
    no_scripts: bool = False,
) -> None:
    """Run the full 6-step pipeline (or scrape-only if requested)."""

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # ── Step 1: Get video inventory ──────────────────────────────────────
    if inventory_path:
        videos = load_inventory_csv(Path(inventory_path))
        channel_name = Path(inventory_path).stem.replace("_inventory", "")
    else:
        if not channel_url:
            print("ERROR: Provide either --channel or --inventory.")
            sys.exit(1)
        channel_name = _extract_channel_name(channel_url)
        videos = scrape_channel_videos(channel_url, num_videos=num_videos, headless=headless)

        # Save inventory
        inv_path = out / f"{channel_name}_inventory_{timestamp}.csv"
        save_inventory_csv(videos, inv_path)

    if not videos:
        print("ERROR: No videos found. Check the channel URL and try again.")
        sys.exit(1)

    if scrape_only:
        print("\n[Done] Scrape-only mode — pipeline stops here.")
        return

    # ── Step 2: Analyse title patterns (Claude) ─────────────────────────
    title_analysis = analyse_title_patterns(videos, channel_name)
    analysis_path = out / f"{channel_name}_title_analysis_{timestamp}.md"
    analysis_path.write_text(title_analysis, encoding="utf-8")
    print(f"  Saved title analysis → {analysis_path}")

    # ── Step 3: Generate Gemini research prompt (Claude) ─────────────────
    gemini_prompt = generate_gemini_prompt(title_analysis, channel_name)
    prompt_path = out / f"{channel_name}_gemini_prompt_{timestamp}.txt"
    prompt_path.write_text(gemini_prompt, encoding="utf-8")
    print(f"  Saved Gemini prompt → {prompt_path}")

    # ── Step 4: Deep trend research (Gemini) ─────────────────────────────
    gemini_research = run_gemini_research(gemini_prompt)
    research_path = out / f"{channel_name}_gemini_research_{timestamp}.md"
    research_path.write_text(gemini_research, encoding="utf-8")
    print(f"  Saved Gemini research → {research_path}")

    # ── Step 5: Generate viral titles (Claude) ───────────────────────────
    titles_output = generate_viral_titles(title_analysis, gemini_research, channel_name)
    titles_path = out / f"{channel_name}_viral_titles_{timestamp}.md"
    titles_path.write_text(titles_output, encoding="utf-8")
    print(f"  Saved viral titles → {titles_path}")

    # ── Step 6: Generate scripts (Claude) ────────────────────────────────
    if not no_scripts:
        scripts_output = generate_scripts(titles_output, title_analysis, channel_name)
        scripts_path = out / f"{channel_name}_scripts_{timestamp}.md"
        scripts_path.write_text(scripts_output, encoding="utf-8")
        print(f"  Saved scripts → {scripts_path}")

    # ── Summary ──────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  PIPELINE COMPLETE")
    print("=" * 60)
    print(f"  Channel:         {channel_name}")
    print(f"  Videos analysed: {len(videos)}")
    print(f"  Output dir:      {out.resolve()}")
    print(f"\n  Files generated:")
    for p in sorted(out.glob(f"{channel_name}_*_{timestamp}.*")):
        print(f"    → {p.name}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="YouTube Viral Title Generator — AI-powered 5-step workflow",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  python youtube_viral_titles.py --channel "https://www.youtube.com/@MrBeast"\n'
            '  python youtube_viral_titles.py --inventory mrbeast_inventory.csv\n'
            '  python youtube_viral_titles.py --channel "https://www.youtube.com/@MrBeast" --scrape-only\n'
        ),
    )
    parser.add_argument(
        "--channel", "-c",
        help="YouTube channel URL (e.g. https://www.youtube.com/@ChannelName)",
    )
    parser.add_argument(
        "--inventory", "-i",
        help="Path to a previously saved inventory CSV (skips Step 1 scraping)",
    )
    parser.add_argument(
        "--num-videos", "-n", type=int, default=100,
        help="Number of videos to scrape (default: 100)",
    )
    parser.add_argument(
        "--output-dir", "-o", default=".",
        help="Directory for output files (default: current directory)",
    )
    parser.add_argument(
        "--scrape-only", action="store_true",
        help="Only scrape the channel inventory — skip AI analysis steps",
    )
    parser.add_argument(
        "--headless", action="store_true",
        help="Run browser in headless mode (default: visible browser)",
    )
    parser.add_argument(
        "--no-scripts", action="store_true",
        help="Skip Step 6 (script generation) — only generate titles",
    )

    args = parser.parse_args()

    if not args.channel and not args.inventory:
        parser.error("Provide either --channel or --inventory")

    # Validate API keys early (unless scrape-only)
    if not args.scrape_only:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("ERROR: ANTHROPIC_API_KEY environment variable not set.")
            print("  Get your key at: https://console.anthropic.com/")
            sys.exit(1)
        if not os.environ.get("GEMINI_API_KEY"):
            print("WARNING: GEMINI_API_KEY not set. Step 4 will use Claude as fallback.")

    run_pipeline(
        channel_url=args.channel,
        inventory_path=args.inventory,
        num_videos=args.num_videos,
        output_dir=args.output_dir,
        scrape_only=args.scrape_only,
        headless=args.headless,
        no_scripts=args.no_scripts,
    )


if __name__ == "__main__":
    main()
