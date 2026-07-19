/**
 * Pincode Monitoring P0-B — narrow, typed wrappers around exactly the four
 * mutating RPCs P0-B routes are allowed to call.
 *
 * SERVER-ROLE SAFETY: this module never accepts an RPC name as a parameter
 * and never exposes a generic `.rpc(name, params)` passthrough — each
 * exported function calls exactly one hardcoded Postgres function name with
 * an explicit, typed parameter object, so a route can never be tricked (by
 * a malformed request body, a future refactor, or a copy-paste mistake)
 * into invoking a Postgres function this feature doesn't own. `claim_due_
 * pincode_targets` and `finalize_pincode_check` are deliberately NOT
 * wrapped here — those are the scheduler's own RPCs (P0-D scope, per
 * IMPLEMENTATION_PLAN.md sec9), not reachable from any P0-B route.
 *
 * `RpcClient` is a minimal structural interface (just the one `.rpc()`
 * method every wrapper needs), not the full `SupabaseClient` type — this
 * lets `__tests__/rpc.test.ts` pass a lightweight fake double and assert
 * exactly which function name and params each wrapper actually sends,
 * without needing a real Supabase connection.
 */

export interface RpcClient {
  // PromiseLike, not Promise -- the real supabase-js client's `.rpc()`
  // returns a thenable `PostgrestFilterBuilder`, not a plain Promise (no
  // `.catch`/`.finally`/`Symbol.toStringTag`), so a stricter `Promise`
  // return type here would reject the real client at the call sites below.
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export class PincodeRpcTransportError extends Error {
  constructor(public readonly rpcName: string, public readonly cause: string) {
    super(`Pincode RPC "${rpcName}" failed: ${cause}`)
    this.name = 'PincodeRpcTransportError'
  }
}

async function callRpc<T>(client: RpcClient, fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, params)
  if (error) throw new PincodeRpcTransportError(fn, error.message)
  return data as T
}

export interface EnrollProductInput {
  asin: string
  product_source: 'owned' | 'other'
  amazon_listing_item_id?: string | null
  tracked_asin_id?: string | null
  pincodes: string[]
  title_snapshot?: string | null
  image_url_snapshot?: string | null
  brand_snapshot?: string | null
}

export async function enrollProducts(
  client: RpcClient,
  args: { workspaceId: string; marketplaceId: string; products: EnrollProductInput[]; quotaLimit: number },
) {
  return callRpc(client, 'enroll_pincode_monitored_products', {
    p_workspace_id: args.workspaceId,
    p_marketplace_id: args.marketplaceId,
    p_products: args.products,
    p_quota_limit: args.quotaLimit,
  })
}

export async function setTrackingState(
  client: RpcClient,
  args: { workspaceId: string; marketplaceId: string; targetIds: string[]; action: 'pause' | 'resume'; quotaLimit: number },
) {
  return callRpc(client, 'set_pincode_tracking_state', {
    p_workspace_id: args.workspaceId,
    p_marketplace_id: args.marketplaceId,
    p_target_ids: args.targetIds,
    p_action: args.action,
    p_quota_limit: args.quotaLimit,
  })
}

export async function removeProducts(
  client: RpcClient,
  args: { workspaceId: string; marketplaceId: string; monitoredProductIds: string[] },
) {
  return callRpc(client, 'remove_pincode_monitored_products', {
    p_workspace_id: args.workspaceId,
    p_marketplace_id: args.marketplaceId,
    p_monitored_product_ids: args.monitoredProductIds,
    p_removal_reason: 'user_requested', // the only value this RPC accepts (063 migration) -- never a free-text reason from the client
  })
}

export async function queueManualCheck(
  client: RpcClient,
  args: {
    targetId: string
    workspaceId: string
    marketplaceId: string
    userId: string
    cooldownSeconds: number
    manualPendingLimit: number
  },
) {
  return callRpc(client, 'queue_pincode_manual_check', {
    p_target_id: args.targetId,
    p_workspace_id: args.workspaceId,
    p_marketplace_id: args.marketplaceId,
    p_user_id: args.userId,
    p_cooldown_seconds: args.cooldownSeconds,
    p_manual_pending_limit: args.manualPendingLimit,
  })
}
