"""
Competitor Intelligence — Keywords & ASIN Configuration
========================================================
Defines the keywords to audit per category and our own ASINs.
Competitor ASINs are discovered dynamically via SERP scraping, but
known high-volume competitors are seeded here for the FC audit.
"""

# ── Keywords to audit per category (most commercially important first) ──────
CATEGORY_KEYWORDS = {
    "ASM": {
        "display_name": "Anti-Slip Mats / Shelf Liners",
        "keywords": [
            "shelf liner for kitchen",
            "shelf liner",
            "kitchen shelf liner",
            "anti slip mat for shelf",
            "drawer liner",
            "fridge mat",
            "anti slip fridge mat",
            "cupboard mat",
            "kitchen drawer mat",
            "wardrobe mat",
        ],
        "our_asins": [
            "B0CN177JS7", "B0BN631JD4", "B0BN5NZCGH", "B0CJJPJP4M",
            "B0CJJSVBSJ", "B0CJR97J2H", "B0CJR9TTCR", "B0CJJP2RLH",
            "B0CJR94LNG", "B0BN5P232F", "B0BN5QG1KJ", "B0F48HZBYQ",
            "B0F48HNNB1",
        ],
        # Known high-volume competitors (seed for FC check)
        "known_competitors": [
            ("B0831486NM", "ElastPro"),
            ("B09VC32SHV", "Trendy Home"),
            ("B0F9TL5RJK", "ESPERO"),
            ("B0F93KHVQ2", "Kuber Industries"),
            ("B0G7YXCRFH", "DALUCI"),
        ],
    },
    "Storage": {
        "display_name": "Storage Bags",
        "keywords": [
            "storage bags for clothes",
            "underbed storage bag",
            "blanket storage bag",
            "clothes storage bag large",
            "storage bag with zipper",
            "underbed storage",
            "blanket cover storage",
            "clothes organizer bag",
        ],
        "our_asins": [
            "B0G1YX6GXV", "B0G1YHH1ZN", "B0G1YT2S5N", "B0G1YQXMCY",
            "B0G1YKGMTJ", "B0G1YWZH29", "B0G1YPPMQR", "B0G1YNMTPK",
            "B0G25TVVSX", "B0G1YPN442", "B0G1YX68NH", "B0G1YY2HCV",
            "B0G1YW28HY", "B0G1YSGT1J", "B0G1YY2HNF",
        ],
        "known_competitors": [],
    },
    "BPM": {
        "display_name": "Baby Play Mat",
        "keywords": [
            "baby play mat",
            "baby gym mat",
            "reversible play mat for baby",
            "foldable baby play mat",
            "baby mat for floor",
            "play mat for babies",
            "baby crawling mat",
            "waterproof baby mat",
        ],
        "our_asins": [
            "B0D92MQ123", "B0GQ4L7R75", "B0D9QXVWLL",
            "B0D54GKMYX", "B0GQ9H6BV3",
        ],
        "known_competitors": [],
    },
    "EVA_Kids": {
        "display_name": "EVA Kids Floor Mat",
        "keywords": [
            "kids foam mat",
            "eva mat for kids",
            "interlocking foam mat for kids",
            "kids play mat foam",
            "kids floor mat",
            "foam floor mat for kids",
            "eva puzzle mat kids",
            "baby floor mat for crawling",
        ],
        "our_asins": [
            "B09MYDPF3Y", "B09MY5K3SH", "B0F228RM13", "B0CRHQLDZG",
            "B0CRHSF42W", "B0CRHST3YZ", "B0D9C1KYDY", "B0D9D3X4WF",
            "B0822GYVNX", "B0822G97QZ", "B0B6VDFMJT", "B0B6T6D2YV",
            "B0F7RLG815", "B0F7RM1269", "B0F7RQKXVL",
            "B0F91VHKKW", "B0FPD2S95J", "B0FP9WSZ8Q", "B0FMP6CMM6",
            "B0CRKRDHL3", "B0CRKQJNL4", "B0F2TCMVWC", "B0D9HBWG5P",
        ],
        "known_competitors": [],
    },
    "EVA_Gym": {
        "display_name": "EVA Gym Floor Mat",
        "keywords": [
            "gym mat for floor",
            "eva gym mat",
            "interlocking gym mat",
            "gym flooring mat",
            "exercise mat foam",
            "workout mat for home",
            "rubber gym mat interlocking",
            "foam mat for gym",
        ],
        "our_asins": [
            "B0CRKV5XTR", "B0CRKV6Z84", "B0CRKV362W",
            "B0C1431JNZ", "B0C141W8X1", "B0C145JTP3", "B0C145GFJY",
            "B0C143T5D8", "B0C1471G4X", "B08642G3SR", "B086424GCB",
            "B0B5RVR7ZF", "B0D9HCMCCY", "B0D9HB8LTP", "B0D9HH4VYG",
            "B0D9HBVW5C", "B0D9HD43H9", "B0D9HDFSH3", "B0D9HBH1XQ",
            "B0F9X8LW1G", "B0DX25VNGF", "B0GL8BF4Z6",
            "B0F2TH8Z6S", "B0F2TLCK85", "B0B6VCW2VK",
        ],
        "known_competitors": [],
    },
}

# ── Major Indian pincodes for FC delivery speed check ────────────────────────
FC_PINCODES = [
    ("Delhi",       "110001"),
    ("Mumbai",      "400001"),
    ("Bangalore",   "560001"),
    ("Hyderabad",   "500001"),
    ("Chennai",     "600001"),
    ("Kolkata",     "700001"),
    ("Pune",        "411001"),
    ("Ahmedabad",   "380001"),
    ("Jaipur",      "302001"),
    ("Lucknow",     "226001"),
]

# ── One representative ASIN per category (our bestseller) for quick FC check ─
OUR_BEST_ASIN_PER_CATEGORY = {
    "ASM":      "B0CJJPJP4M",   # our main shelf liner
    "Storage":  "B0G1YX6GXV",   # our main storage bag
    "BPM":      "B0D92MQ123",   # our baby play mat
    "EVA_Kids": "B09MYDPF3Y",   # our main kids mat
    "EVA_Gym":  "B0CRKV5XTR",   # our main gym mat
}
