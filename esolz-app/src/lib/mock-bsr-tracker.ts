// ─── BSR Tracker mock data ────────────────────────────────────────────────────

export interface BsrTrackerAlert {
  id: string
  asin: string
  label: string
  type: 'sharp_drop' | 'significant_gain' | 'no_data' | 'potential_oos' | 'buybox_impact'
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}

export const BSR_TRACKER_ALERTS: BsrTrackerAlert[] = [
  {
    id: 'bta1',
    asin: 'B0C3KJR45M',
    label: 'Neem Face Wash 200ml',
    type: 'significant_gain',
    message: 'BSR improved from #315 → #289. Now in Top 10 of Face Wash sub-category.',
    severity: 'success',
    timestamp: new Date(Date.now() - 1 * 3600000).toISOString(),
  },
  {
    id: 'bta2',
    asin: 'B09W2N5K3X',
    label: 'Herbal Tea Blend 250g',
    type: 'sharp_drop',
    message: 'BSR dropped from #1,650 → #1,842. Rank worsened by 192 positions in 24h.',
    severity: 'error',
    timestamp: new Date(Date.now() - 2 * 3600000).toISOString(),
  },
  {
    id: 'bta3',
    asin: 'B0BN5NZCGH',
    label: 'Daily Herbs Ghee 1L',
    type: 'significant_gain',
    message: 'BSR improved from #380 → #342. Consistent upward momentum over 7 days.',
    severity: 'success',
    timestamp: new Date(Date.now() - 3 * 3600000).toISOString(),
  },
  {
    id: 'bta4',
    asin: 'B07XQFM2XK',
    label: 'Organic Turmeric Powder',
    type: 'sharp_drop',
    message: 'BSR dropped from #4,900 → #5,621. Low availability (35%) may be contributing.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 5 * 3600000).toISOString(),
  },
  {
    id: 'bta5',
    asin: 'B07XQFM2XK',
    label: 'Organic Turmeric Powder',
    type: 'potential_oos',
    message: 'Availability score is at 35%. Risk of stock-out could further hurt BSR.',
    severity: 'warning',
    timestamp: new Date(Date.now() - 6 * 3600000).toISOString(),
  },
  {
    id: 'bta6',
    asin: 'B09W2N5K3X',
    label: 'Herbal Tea Blend 250g',
    type: 'buybox_impact',
    message: 'Buy Box lost to TeaWorld Store. This may be causing the BSR decline.',
    severity: 'error',
    timestamp: new Date(Date.now() - 8 * 3600000).toISOString(),
  },
  {
    id: 'bta7',
    asin: 'B08JK2MN7P',
    label: 'Ashwagandha Capsules 60ct',
    type: 'no_data',
    message: 'No BSR data collected yet for this ASIN. Verify it is live on Amazon.in.',
    severity: 'info',
    timestamp: new Date(Date.now() - 10 * 3600000).toISOString(),
  },
]
