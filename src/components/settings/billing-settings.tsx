'use client';

// ============================================================
// BillingSettings — current plan, usage bars, trial days, and a
// placeholder subscribe button. Real checkout is Cycle B.
// ============================================================

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { resolveEntitlements, type SubscriptionRow, type PlanLimits } from '@/lib/billing/entitlements';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface View {
  plan: PlanLimits & { id: string; name: string };
  sub: SubscriptionRow;
  numbers: number;
  contacts: number;
}

function Bar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground tabular-nums">
          {used.toLocaleString()} / {max.toLocaleString()}
        </span>
      </div>
      <div className="bg-muted h-2 overflow-hidden rounded-full">
        <div
          className={pct >= 100 ? 'bg-red-500 h-full' : 'bg-primary h-full'}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function BillingSettings() {
  const { accountId } = useAuth();
  const [v, setV] = useState<View | null>(null);

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
        .select('id, name, max_numbers, max_contacts, max_ai_messages')
        .eq('id', sub.plan_id)
        .maybeSingle();
      const { count: numbers } = await supabase.from('channels').select('id', { count: 'exact', head: true });
      const { count: contacts } = await supabase.from('contacts').select('id', { count: 'exact', head: true });
      if (plan) {
        setV({ plan: plan as View['plan'], sub: sub as SubscriptionRow, numbers: numbers ?? 0, contacts: contacts ?? 0 });
      }
    })();
  }, [accountId]);

  if (!v) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  const ent = resolveEntitlements(v.sub, v.plan);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Plano &amp; cobrança</h2>
        <p className="text-sm text-muted-foreground">
          Plano atual: <strong className="text-foreground">{v.plan.name}</strong>
          {ent.trialDaysLeft !== null && ` · trial: ${ent.trialDaysLeft} dia(s) restante(s)`}
          {ent.blocked && ' · bloqueado'}
        </p>
      </div>
      <div className="border-border bg-card space-y-3 rounded-xl border p-5">
        <Bar label="Números conectados" used={v.numbers} max={v.plan.max_numbers} />
        <Bar label="Contatos" used={v.contacts} max={v.plan.max_contacts} />
        <Bar label="Mensagens de IA (ciclo)" used={ent.aiUsed} max={v.plan.max_ai_messages} />
      </div>
      <Button onClick={() => toast.info('Checkout em breve.')}>Assinar / Fazer upgrade</Button>
    </div>
  );
}
