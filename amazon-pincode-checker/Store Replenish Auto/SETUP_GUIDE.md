# Amazon SP-API Setup Guide (India Marketplace)

## What You Need
To connect directly to your Amazon India seller account, you must register a **Selling Partner API (SP-API)** application. This is a one-time setup.

---

## Step 1: Create an AWS Account (if you don't have one)
1. Go to https://aws.amazon.com/ → **Create an AWS Account**
2. Complete registration (free tier is sufficient)
3. **Important**: Save your AWS account ID

## Step 2: Create an IAM User & Policy in AWS
1. Go to AWS Console → **IAM** → **Policies** → **Create Policy**
2. Click **JSON** tab and paste this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:*:*:*"
    }
  ]
}
```

3. Name it `SellingPartnerAPIPolicy` → **Create**
4. Go to **IAM** → **Users** → **Create User**
   - Name: `sp-api-user`
   - Attach the `SellingPartnerAPIPolicy`
5. Go to the user → **Security Credentials** → **Create Access Key**
   - Choose "Application running outside AWS"
   - **Save the Access Key ID and Secret Access Key** — you'll need these

## Step 3: Register as a Developer in Seller Central
1. Log in to https://sellercentral.amazon.in
2. Go to **Settings** → **User Permissions**
3. At the bottom, click **Visit Developer Central** (or go to **Apps & Services** → **Develop Apps**)
4. Click **Register as a Developer** if not already registered
5. Fill in:
   - **Developer name**: Your company name
   - **AWS Account ID**: From Step 1
   - **IAM ARN**: `arn:aws:iam::<YOUR_AWS_ACCOUNT_ID>:user/sp-api-user`
6. Accept the terms and register

## Step 4: Create a New App
1. In Developer Central, click **Add new app client**
2. Fill in:
   - **App name**: `Fulfillment Plan Generator`
   - **API Type**: `SP API`
   - **IAM ARN**: Same as above
3. Select these **Roles**:
   - ✅ Direct-to-Consumer Shipping
   - ✅ Inventory and Order Management
4. Click **Save and exit**
5. After creation, click **View** next to your app → **LWA Credentials**
   - **Save the Client ID** (starts with `amzn1.application-oa2-client.xxxx`)
   - **Save the Client Secret**

## Step 5: Self-Authorize Your App
1. In Developer Central, find your app
2. Click the **Authorize** button (or the dropdown arrow → **Authorize**)
3. This generates a **Refresh Token** — **SAVE IT IMMEDIATELY** (shown only once!)

## Step 6: Run the Setup Wizard
Open a terminal in the project folder and run:

```
python amazon_api.py --setup
```

Enter the 5 credentials when prompted:
1. **LWA App ID** (Client ID from Step 4)
2. **LWA Client Secret** (from Step 4)
3. **Refresh Token** (from Step 5)
4. **AWS Access Key ID** (from Step 2)
5. **AWS Secret Access Key** (from Step 2)

## Step 7: Test the Connection
```
python amazon_api.py --test
```

If successful, you'll see "Connection working!" and can run the generator:

```
python fulfillment_plan_generator.py --api
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Access denied` | Check IAM policy has `execute-api:Invoke` permission |
| `Invalid grant` | Refresh token may have expired — re-authorize the app in Step 5 |
| `App not found` | App may still be under review — wait 24 hours |
| `QuotaExceeded` | API rate limit hit — the script auto-retries, just wait |
| `Marketplace not found` | Ensure you registered on sellercentral.amazon.**in** (not .com) |

---

## Security Notes
- **Never share** your `sp_api_config.json` file
- **Never commit** it to Git (`.gitignore` is already set up)
- The refresh token does not expire unless you revoke it
- Rotate your AWS access keys periodically (every 90 days recommended)
