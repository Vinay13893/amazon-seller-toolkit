# Amazon Marketing Stream v2 setup for Brahmastra

Status: infrastructure checklist. Brahmastra must remain in shadow mode until
the destination, ingestion, reconciliation and rollback tests all pass.

## What Marketing Stream adds

Amazon Marketing Stream supplies advertising facts at each dataset's fixed
hourly or daily grain. It does not contain retail facts such as inventory,
organic sales, supplier cost or contribution margin. Brahmastra combines it
with Ads Reporting, Ads campaign-management APIs, SP-API retail data and the
keyword-rank tracker.

Stream v2 delivers Parquet files to Amazon S3 and sends an SQS notification for
each delivery. Amazon Ads does not charge for Stream; normal AWS S3, SQS, data
transfer, Athena/Glue and optional KMS charges can apply.

## What the account owner must do

1. Sign in to the AWS account that will own Brahmastra's advertising data.
2. Open Amazon's official **Set up your destination** page and use its
   CloudFormation template (recommended). Do not copy policies from a blog.
3. For an India/Far East Amazon Ads profile, choose an allowed FE destination
   region: `ap-southeast-1` or `us-west-2`. Keep the S3 bucket and SQS queue in
   the same region.
4. Create a dedicated destination for the Brahmastra Amazon Ads client app.
   Do not reuse a destination registered by a different Ads API application.
5. Use a standard SQS queue, not FIFO. Keep the dead-letter queue created by
   the template.
6. Keep the S3 bucket private. Enable block-public-access, encryption,
   versioning, access logging and a lifecycle policy. A practical starting
   retention is 180 days before moving older raw files to cheaper storage.
7. Record these non-secret values:
   - AWS region
   - S3 bucket ARN
   - SQS queue ARN and queue URL
   - Amazon Ads advertiser/profile ID
8. Create a least-privilege Brahmastra consumer identity that can only:
   - receive/delete messages from this queue;
   - read objects from this Stream bucket prefix;
   - decrypt only the destination key, if a customer-managed KMS key is used.
9. Put its credentials only in the Render service's secret environment
   settings. Never paste access keys in chat, source code, Git, Vercel browser
   variables, logs or screenshots.
10. Send the four non-secret values from step 7 to the developer. Do not send
    AWS secret keys or Amazon refresh tokens.

## What Brahmastra will do after the destination exists

1. Use the existing Amazon Ads OAuth credentials to query the current Stream
   v2 dataset catalog for the FE region.
2. Create one subscription per required dataset for one advertiser account,
   reusing the dedicated S3 + SQS destination.
3. Consume only SQS-listed files. S3 object-created events are not a substitute
   because they do not describe a complete delivery.
4. Read every notified Parquet file. A file may contain records from more than
   one subscription, so rows are filtered by advertiser account and dataset.
5. Upsert at the full dataset dimension key and keep the greatest
   `streamBatch.version`. A repeated delivery is a restated total, not a delta.
6. Preserve `null` as unavailable. It must never be converted to zero.
7. Send bad messages to the dead-letter queue and alert before data freshness
   exceeds the safety threshold.
8. Reconcile hourly/daily totals against Ads Reporting before the data can
   influence a recommendation.

## Required subscriptions

Dataset identifiers change as Amazon expands Stream v2. Brahmastra must verify
the live official catalog at setup time instead of relying only on a blog or a
stale list. As of this design review, the required current datasets are:

- `ads-performance-v1` — hourly SP, SB and SD facts, including campaign,
  ad group, ad, advertised product/ASIN/SKU, target, search term and placement
  dimensions where applicable. Its documented restatement window is 70 days.
- `ads-converted-product-v1` — daily purchased-product/halo conversion facts;
  its documented restatement window is also 70 days.

Budget-usage APIs and product-eligibility APIs remain separate checks. They are
not replaced by Stream.

## Activation gates

The system advances in this order:

1. **Shadow:** compute recommendations and predicted impact; no Amazon writes.
2. **Approval:** a workspace administrator approves each bounded proposal;
   Brahmastra reads the entity back after the write and can roll it back.
3. **Autopilot pilot:** only allowlisted campaigns, hard daily loss caps,
   emergency stop, 24-hour cooldown and maximum 10% bid changes.
4. **Broader autopilot:** only after at least 30 days of reconciled experiments
   show no cross-workspace leakage and no guardrail breach.

Autopilot remains disabled when profit inputs are incomplete. Amazon does not
know the seller's supplier/purchase cost; until a trusted automatic cost source
exists, Brahmastra may optimize ad efficiency but must label true profit as
unavailable.

## Official references

- https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/v2/set-up-your-destination
- https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/v2/faq
- https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/v2/manage-subscriptions/limits
- https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/overview
