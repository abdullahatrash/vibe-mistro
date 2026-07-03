import type { AccountPlan } from '../../../shared/ipc'

/**
 * Derive the display label for the account's plan tier — a chip-friendly port
 * of Vibe's `plan_title` (vibe/cli/plan_offer/decide_plan_offer.py) minus its
 * `[Subscription]`/`[API]` prefixes. The plan-name matching mirrors Vibe's
 * `PlanInfo` predicates exactly (CHAT names are exact matches, API "free" is a
 * substring test, MISTRAL_CODE uses single-letter names). Returns null when
 * the tier is unknown — callers fall back to their static label.
 */
export function planLabel(plan: AccountPlan | null): string | null {
  if (!plan) return null
  const name = plan.planName.toUpperCase()
  switch (plan.planType) {
    case 'CHAT':
      if (name === 'FREE') return 'Free'
      if (name === 'INDIVIDUAL' || name === 'EDU' || name === 'TEAM') return 'Pro'
      return null
    case 'API':
      return name.includes('FREE') ? 'Free' : 'Scale plan'
    case 'MISTRAL_CODE':
      if (name === 'F') return 'Mistral Code Free'
      if (name === 'E') return 'Mistral Code Enterprise'
      return null
    default:
      return null
  }
}
