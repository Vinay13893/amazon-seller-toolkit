"""
EMOUNT Ventures — Category Configuration
==========================================
Defines the 6 product categories with their:
  - SKU pattern matching rules (from SKU names and campaign names)
  - Target ROI from Ads and Blended
  - Target ACoS derived from Ads ROI
"""

CATEGORIES = {
    "ASM": {
        "display_name": "Anti-Slip Mats (Shelf Liners)",
        "description": "Kitchen shelf liners, drawer mats, cupboard sheets",
        "target_ads_roi": 5.0,       # 5x ROAS from ads
        "target_blended_roi": 10.0,  # 10x blended (ads + organic)
        "target_acos": 20.0,         # 1/5 = 20% ACoS
        # SKU patterns (case-insensitive substring match)
        "sku_patterns": [
            "antiskidmat", "antislipmat", "anti_slip", "anti_skid",
            "asm_", "asm-",
            "shelf_liner", "drawer_mat", "cupboard",
        ],
        # Campaign name patterns
        "campaign_patterns": [
            "asm", "anti-slip", "antislip", "shelf liner", "drawer mat",
            "kitchen shelf", "kitchen mat", "kitchen sheet", "kitchen liner",
            "kitchen cabinet", "wardrobe mat", "wardrobe sheet",
            "cupboard sheet", "shelf mat", "transparent plastic sheet",
        ],
        # Direct ASIN list (from the ads ASIN report — ASM products)
        "asins": [
            "B0CN177JS7", "B0BN631JD4", "B0BN5NZCGH", "B0CJJPJP4M",
            "B0CJJSVBSJ", "B0CJR97J2H", "B0CJR9TTCR", "B0CJJP2RLH",
            "B0CJR94LNG", "B0BN5P232F", "B0BN5QG1KJ", "B0F48HZBYQ",
            "B0F48HNNB1",
        ],
    },

    "EVA_Kids": {
        "display_name": "EVA Kids Floor Mat (Multicolor)",
        "description": "Multicolor interlocking EVA kids play mats, puzzle mats",
        "target_ads_roi": 10.0,
        "target_blended_roi": 18.0,
        "target_acos": 10.0,         # 1/10 = 10% ACoS
        "sku_patterns": [
            "eh-multicolor", "eh_eva_multi", "eva_mats_multi", "eva_mat_multi",
            "liltoes", "lil_eva_multi", "ehk_eva_multi",
            "eh-black-interlock",  # interlock multicolor variant
            "eh_eva_blue_grey_white", "eh_eva_orange_sea",
            "eh_eva_yellow_sea", "eh_eva_all_multicolor",
            "eh_diamond_eva_multi", "fmp6cmm6",
            "crhqldzg", "crhsf42w", "crhst3yz",  # LT_EVA_MULTI
            "fp9wsz8q",  # Lil_EVA
            "f228rm13", "f7rlg815", "f7rm1269", "f7rqkxvl",
            "f91vhkkw", "fpd2s95j",
        ],
        "campaign_patterns": [
            "eva kids", "kids mat", "kids play", "kids foam", "kids tile",
            "kids floor", "interlocking play", "foam mat for kids",
            "play mat for kids", "playmat for kids", "floor mat for kids",
            "ehomekart", "liltoes", "eva mats for kids",
            "baby floor mat for crawling", "multicolor",
        ],
        "asins": [
            "B09MYDPF3Y", "B09MY5K3SH",  # EH-Multicolor/Black Interlock
            "B0F228RM13", "B0CRHQLDZG", "B0CRHSF42W", "B0CRHST3YZ",
            "B0D9C1KYDY", "B0D9D3X4WF",  # Lil EVA MULTI
            "B0822GYVNX", "B0822G97QZ", "B0B6VDFMJT", "B0B6T6D2YV",  # eva_mats_multi
            "B0F7RLG815", "B0F7RM1269", "B0F7RQKXVL",  # New PO9 colors
            "B0F91VHKKW", "B0FPD2S95J", "B0FP9WSZ8Q", "B0FMP6CMM6",
            "B0CRKRDHL3", "B0CRKQJNL4",  # eHK_EVA_MULTI
            "B0F2TCMVWC",  # may be ambiguous but SKU says "Black-Mat-8" interlock
            "B0D9HBWG5P",  # DIAMOND EVA MULTI
        ],
    },

    "EVA_Gym": {
        "display_name": "EVA Gym Floor Mat (Black/Grey)",
        "description": "Black, grey EVA interlocking gym/workout floor mats",
        "target_ads_roi": 10.0,
        "target_blended_roi": 18.0,
        "target_acos": 10.0,
        "sku_patterns": [
            "ehk_eva_black", "eh_eva_black", "eva_mats_black",
            "eh_eva_grey", "eh_black&grey", "ehk_black&grey",
            "eva_mat_grey", "eh_eva_brown&beige",
            "dx25vngf", "gl8bf4z6",  # specific ASINs
            "b6t6d2yv",  # grey 4
        ],
        "campaign_patterns": [
            "eva gym", "gym mat", "gym floor", "gym carpet",
            "gym equipment", "rubber mat", "rubber floor",
            "interlocking floor mat", "foam mat",
            "workout", "exercise mat", "gym flooring",
            "ehk gym", "b&g gym",
        ],
        "asins": [
            "B0CRKV5XTR", "B0CRKV6Z84", "B0CRKV362W",  # eHK_EVA_Black
            "B0C1431JNZ", "B0C141W8X1", "B0C145JTP3", "B0C145GFJY",
            "B0C143T5D8", "B0C1471G4X",  # EH_EVA_Black/Grey
            "B08642G3SR", "B086424GCB", "B0B5RVR7ZF",  # eva_mats_black
            "B0D9HCMCCY", "B0D9HB8LTP", "B0D9HH4VYG",  # EH_Black&Grey_EVA
            "B0D9HBVW5C", "B0D9HD43H9", "B0D9HDFSH3", "B0D9HBH1XQ",
            "B0F9X8LW1G",  # Brown&Beige
            "B0DX25VNGF",  # eh_eva_mats_black_8
            "B0GL8BF4Z6",  # Black&Grey Leaf
            "B0F2TH8Z6S", "B0F2TLCK85",  # eva_mats_black PO
            "B0B6VCW2VK",  # eva_mat_grey
        ],
    },

    "BPM": {
        "display_name": "Baby Play Mat (Reversible/Foldable)",
        "description": "Baby reversible foldable play mats by LilToes brand",
        "target_ads_roi": 5.5,       # 5-6x from ads
        "target_blended_roi": 11.0,  # 10-12x blended
        "target_acos": 18.0,         # ~1/5.5 ≈ 18%
        "sku_patterns": [
            "lt_baby_play_mat", "baby_play_mat",
            "bpm", "liltoes_bpm",
        ],
        "campaign_patterns": [
            "bpm", "baby play mat", "baby mat", "baby playing mat",
            "mat for baby", "play mat for babies",
            "kids mats for floor thick",
        ],
        "asins": [
            "B0D92MQ123", "B0GQ4L7R75", "B0D9QXVWLL",
            "B0D54GKMYX", "B0GQ9H6BV3",
        ],
    },

    "Storage": {
        "display_name": "Storage Bags",
        "description": "Storage bags, underbed storage, blanket covers, clothes storage",
        "target_ads_roi": 5.5,
        "target_blended_roi": 11.0,
        "target_acos": 18.0,
        "sku_patterns": [
            "sb_", "storage_bag", "blanket_cover", "blanket_storage",
            "underbed", "under_bed", "clothes_storage",
        ],
        "campaign_patterns": [
            "storage bag", "blanket cover", "blanket storage",
            "under bed", "underbed", "clothes storage",
            "storage organizer",
        ],
        "asins": [
            "B0G1YX6GXV", "B0G1YHH1ZN", "B0G1YT2S5N", "B0G1YQXMCY",
            "B0G1YKGMTJ", "B0G1YWZH29", "B0G1YPPMQR", "B0G1YNMTPK",
            "B0G25TVVSX", "B0G1YPN442", "B0G1YX68NH", "B0G1YY2HCV",
            "B0G1YW28HY", "B0G1YSGT1J", "B0G1YY2HNF",
        ],
    },

    "WTC": {
        "display_name": "Water Tank Cover",
        "description": "Water tank covers/protectors",
        "target_ads_roi": 10.0,
        "target_blended_roi": 20.0,
        "target_acos": 10.0,
        "sku_patterns": [
            "wtc", "water_tank", "tank_cover",
        ],
        "campaign_patterns": [
            "water tank", "tank cover",
        ],
        "asins": [],  # will be populated when WTC products launch ads
    },
}


def classify_asin(asin, sku=""):
    """Classify an ASIN into a category. Returns category key or 'UNCATEGORIZED'."""
    asin = asin.strip().upper()
    sku_lower = sku.strip().lower()

    # 1. Direct ASIN match (fastest, most accurate)
    for cat_key, cat in CATEGORIES.items():
        if asin in cat["asins"]:
            return cat_key

    # 2. SKU pattern match
    if sku_lower:
        for cat_key, cat in CATEGORIES.items():
            for pat in cat["sku_patterns"]:
                if pat.lower() in sku_lower:
                    return cat_key

    return "UNCATEGORIZED"


def classify_campaign(campaign_name):
    """Classify a campaign name into a category. Returns category key or 'UNCATEGORIZED'."""
    name_lower = campaign_name.strip().lower()

    for cat_key, cat in CATEGORIES.items():
        for pat in cat["campaign_patterns"]:
            if pat.lower() in name_lower:
                return cat_key

    return "UNCATEGORIZED"


def get_target(category_key, metric="target_acos"):
    """Get a target metric for a category. Returns None if not found."""
    cat = CATEGORIES.get(category_key)
    if cat:
        return cat.get(metric)
    return None
