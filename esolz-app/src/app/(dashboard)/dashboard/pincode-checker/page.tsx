import { PincodeMonitor } from '@/components/pincode-monitoring/PincodeMonitor'
import { FeatureGuide } from '@/components/onboarding/FeatureGuide'

export default function PincodeCheckerPage() {
  return <>
    <FeatureGuide guideKey="pincode" title="Pincode Checker" steps={[
      { title: 'Add a product', description: 'Choose one of your own or competitor ASINs. Both count toward the same plan allowance.' },
      { title: 'Choose delivery locations', description: 'Add the pincodes that matter to your customers, then use Check now for an immediate result.' },
      { title: 'Turn on daily monitoring', description: 'Saved combinations are checked automatically each day. Open History to compare every preserved result.' },
      { title: 'Know your allowance', description: 'The Beta plan includes 100 pincode checks per month. Your usage and next refresh stay visible in this tab.' },
    ]} />
    <PincodeMonitor />
  </>
}
