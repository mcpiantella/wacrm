'use client';

// ============================================================
// SdrConfigCard — per-campaign SDR (AI qualifier) configuration.
// Lives on the broadcast detail page. Members see it read-only;
// admins+ edit (gated by <RequireRole> + the admin-only PUT route).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RequireRole } from '@/components/auth/require-role';

interface SdrConfig {
  enabled: boolean;
  system_prompt: string | null;
  qualification_criteria: string[];
  model: string | null;
  handoff_keywords: string[];
  max_turns: number;
  debounce_seconds: number;
  follow_up_enabled: boolean;
  follow_up_delays: number[];
  cold_tag: string;
}

const EMPTY: SdrConfig = {
  enabled: false,
  system_prompt: '',
  qualification_criteria: [],
  model: null,
  handoff_keywords: [],
  max_turns: 20,
  debounce_seconds: 12,
  follow_up_enabled: true,
  follow_up_delays: [180, 1440],
  cold_tag: 'lead-frio',
};

export function SdrConfigCard({ broadcastId }: { broadcastId: string }) {
  const [config, setConfig] = useState<SdrConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [briefing, setBriefing] = useState('');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sdr/config?broadcast_id=${broadcastId}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const { config: c } = (await res.json()) as { config: SdrConfig | null };
        if (c) setConfig({ ...EMPTY, ...c, system_prompt: c.system_prompt ?? '' });
      }
    } catch (err) {
      console.error('[SdrConfigCard] load', err);
    } finally {
      setLoading(false);
    }
  }, [broadcastId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    if (briefing.trim().length < 10) {
      toast.error('Descreva a campanha com pelo menos 10 caracteres.');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch('/api/sdr/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefing: briefing.trim() }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Falha ao gerar com IA');
        return;
      }
      const g = payload.config as Partial<SdrConfig>;
      // Fill the form with the draft — the user reviews and saves.
      setConfig((c) => ({
        ...c,
        system_prompt: g.system_prompt ?? c.system_prompt,
        qualification_criteria: g.qualification_criteria ?? c.qualification_criteria,
        handoff_keywords: g.handoff_keywords ?? c.handoff_keywords,
      }));
      toast.success('Rascunho gerado — revise e salve.');
    } catch (err) {
      console.error('[SdrConfigCard] generate', err);
      toast.error('Não foi possível alcançar o servidor');
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/sdr/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcast_id: broadcastId, ...config }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Falha ao salvar configuração SDR');
        return;
      }
      toast.success('Configuração SDR salva');
    } catch (err) {
      console.error('[SdrConfigCard] save', err);
      toast.error('Não foi possível alcançar o servidor');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="text-primary size-5 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="text-primary size-5" />
            <h3 className="text-foreground text-sm font-semibold">AI SDR (qualifier)</h3>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="sdr-enabled" className="text-muted-foreground text-xs">
              {config.enabled ? 'Ativado' : 'Desativado'}
            </Label>
            <Switch
              id="sdr-enabled"
              checked={config.enabled}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, enabled: v }))}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Quando ativado, respostas a esta campanha são respondidas pelo AI SDR até
          o handoff. Ative por conversa na caixa de entrada.
        </p>

        {/* AI generator — admins describe the campaign and the model drafts
            the prompt + criteria + handoff keywords below. */}
        <RequireRole min="admin">
          <div className="border-border bg-muted/40 space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Sparkles className="text-primary size-4" />
              <Label htmlFor="sdr-briefing" className="text-xs font-medium">
                Gerar com IA
              </Label>
            </div>
            <Textarea
              id="sdr-briefing"
              rows={2}
              placeholder="Descreva a campanha: produto/serviço, objetivo e o que qualificar. Ex.: Imobiliária em SP; quero saber se o lead quer alugar ou comprar, faixa de orçamento e prazo."
              value={briefing}
              onChange={(e) => setBriefing(e.target.value)}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={generate}
                disabled={generating}
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Gerar rascunho
              </Button>
            </div>
            <p className="text-muted-foreground text-[10px]">
              Preenche os campos abaixo. Revise antes de salvar.
            </p>
          </div>
        </RequireRole>

        <div className="space-y-1.5">
          <Label htmlFor="sdr-prompt">System prompt</Label>
          <Textarea
            id="sdr-prompt"
            rows={5}
            placeholder="Você é um SDR de… Seu objetivo é qualificar o lead perguntando…"
            value={config.system_prompt ?? ''}
            onChange={(e) => setConfig((c) => ({ ...c, system_prompt: e.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sdr-criteria">Critérios de qualificação (um por linha)</Label>
          <Textarea
            id="sdr-criteria"
            rows={3}
            placeholder={'Tem orçamento definido\nÉ o decisor\nQuer comprar em até 30 dias'}
            value={config.qualification_criteria.join('\n')}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                qualification_criteria: e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }))
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sdr-keywords">Palavras-chave de handoff (separadas por vírgula)</Label>
            <Input
              id="sdr-keywords"
              placeholder="falar com humano, atendente"
              value={config.handoff_keywords.join(', ')}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  handoff_keywords: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }))
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sdr-debounce">Debounce (s)</Label>
              <Input
                id="sdr-debounce"
                type="number"
                min={5}
                max={60}
                value={config.debounce_seconds}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, debounce_seconds: Number(e.target.value) }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sdr-turns">Máx. de turnos</Label>
              <Input
                id="sdr-turns"
                type="number"
                min={1}
                max={200}
                value={config.max_turns}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, max_turns: Number(e.target.value) }))
                }
              />
            </div>
          </div>
        </div>

        <div className="border-border space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="sdr-followup" className="text-xs font-medium">
              Follow-up automático
            </Label>
            <Switch
              id="sdr-followup"
              checked={config.follow_up_enabled}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, follow_up_enabled: v }))}
            />
          </div>
          <p className="text-muted-foreground text-[11px]">
            Se o lead parar de responder, o SDR manda lembretes nestes intervalos
            (horas após a última pergunta) e encerra como frio depois do último.
          </p>
          <Input
            id="sdr-followup-delays"
            placeholder="3, 24"
            value={config.follow_up_delays.map((m) => +(m / 60).toFixed(2)).join(', ')}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                follow_up_delays: e.target.value
                  .split(',')
                  .map((s) => Math.round(parseFloat(s.trim()) * 60))
                  .filter((n) => Number.isFinite(n) && n > 0),
              }))
            }
          />
        </div>

        <RequireRole min="admin">
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Salvar configuração SDR
            </Button>
          </div>
        </RequireRole>
      </CardContent>
    </Card>
  );
}
