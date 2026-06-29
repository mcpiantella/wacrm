'use client';

// ============================================================
// SdrCampaignStats — per-campaign SDR outcome counts, shown on the
// broadcast detail page beside the config. Self-contained: reads
// sdr_runs (RLS member-scoped) for this broadcast. Hides until the
// SDR has actually run on the campaign.
// ============================================================

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Bot, Bell, UserRound, Snowflake } from 'lucide-react';

interface Stats {
  qualified: number;
  followUps: number;
  handoffs: number;
  cold: number;
}

export function SdrCampaignStats({ broadcastId }: { broadcastId: string }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const countAction = (action: string) =>
      supabase
        .from('sdr_runs')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
        .eq('action', action);

    void Promise.all([
      countAction('reply'),
      countAction('followup'),
      countAction('handoff'),
      countAction('cold'),
    ])
      .then(([q, f, h, c]) =>
        setStats({
          qualified: q.count ?? 0,
          followUps: f.count ?? 0,
          handoffs: h.count ?? 0,
          cold: c.count ?? 0,
        }),
      )
      .catch(() => setStats({ qualified: 0, followUps: 0, handoffs: 0, cold: 0 }));
  }, [broadcastId]);

  if (!stats) return null;
  const total = stats.qualified + stats.followUps + stats.handoffs + stats.cold;
  if (total === 0) return null; // nothing to show until the SDR has run here

  const items = [
    { icon: Bot, label: 'Qualificações', value: stats.qualified },
    { icon: Bell, label: 'Follow-ups', value: stats.followUps },
    { icon: UserRound, label: 'Handoffs', value: stats.handoffs },
    { icon: Snowflake, label: 'Leads frios', value: stats.cold },
  ];

  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-foreground mb-3 text-sm font-semibold">Desempenho do SDR</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map(({ icon: Icon, label, value }) => (
          <div key={label} className="border-border rounded-lg border p-3">
            <Icon className="text-muted-foreground size-4" />
            <p className="text-foreground mt-2 text-xl font-bold tabular-nums">{value}</p>
            <p className="text-muted-foreground text-xs">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
