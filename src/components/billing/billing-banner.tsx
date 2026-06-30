'use client';

// ============================================================
// BillingBanner — app-shell banner shown when the trial is ending
// soon (<=2 days) or the account is blocked. Links to billing settings.
// ============================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { resolveEntitlements, type SubscriptionRow, type PlanLimits } from '@/lib/billing/entitlements';
import { AlertTriangle } from 'lucide-react';

const FALLBACK_PLAN: PlanLimits = { max_numbers: 1, max_contacts: 50, max_ai_messages: 50 };

export function BillingBanner() {
  const { accountId } = useAuth();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    void (async () => {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status, plan_id, trial_ends_at, current_period_end, ai_messages_used, cycle_reset_at')
        .eq('account_id', accountId)
        .maybeSingle();
      if (!sub) return;
      const { data: plan } = await supabase
        .from('plans')
        .select('max_numbers, max_contacts, max_ai_messages')
        .eq('id', sub.plan_id)
        .maybeSingle();
      const ent = resolveEntitlements(sub as SubscriptionRow, (plan as PlanLimits) ?? FALLBACK_PLAN);
      if (ent.blocked) setMsg('Sua conta está bloqueada — assine para voltar a disparar.');
      else if (ent.trialDaysLeft !== null && ent.trialDaysLeft <= 2)
        setMsg(`Seu período de teste termina em ${ent.trialDaysLeft} dia(s). Assine para continuar.`);
      else setMsg(null);
    })();
  }, [accountId]);

  if (!msg) return null;
  return (
    <Link
      href="/settings?tab=billing"
      className="flex items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-400 hover:bg-amber-500/20"
    >
      <AlertTriangle className="h-4 w-4" />
      {msg}
    </Link>
  );
}
