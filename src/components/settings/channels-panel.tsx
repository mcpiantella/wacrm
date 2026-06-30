'use client';

// ============================================================
// ChannelsPanel — Settings → Channels
//
// Lists every WhatsApp number the account can send/receive on, across
// both providers (Cloud API + Evolution). Any member sees the roster;
// admins+ add Evolution numbers and remove channels (gated by
// <RequireRole min="admin"> + the admin-only API routes + RLS).
//
// Cloud numbers are set up in the WhatsApp tab (Meta registration flow);
// here they appear read-only. Evolution numbers are managed inline —
// the API key is encrypted server-side, never shown back.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Radio, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

type Provider = 'cloud' | 'evolution';

interface Channel {
  id: string;
  provider: Provider;
  identifier: string;
  display_name: string | null;
  phone_e164: string | null;
  status: string;
  connected_at: string | null;
  capabilities: { templates: boolean; freeform: boolean };
}

const PROVIDER_LABEL: Record<Provider, string> = {
  cloud: 'WhatsApp Cloud API',
  evolution: 'Evolution API',
};

const EMPTY_FORM = {
  display_name: '',
  instance: '',
  base_url: '',
  api_key: '',
  phone_e164: '',
};

export function ChannelsPanel() {
  const { canEditSettings } = useAuth();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/channels', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao carregar canais');
        return;
      }
      const data = (await res.json()) as { channels: Channel[] };
      setChannels(data.channels);
    } catch (err) {
      console.error('[ChannelsPanel] load error:', err);
      toast.error('Não foi possível alcançar o servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAddEvolution() {
    setSaving(true);
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'evolution', ...form }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Falha ao salvar canal');
        return;
      }
      toast.success('Número Evolution salvo');
      setAddOpen(false);
      setForm({ ...EMPTY_FORM });
      void load();
    } catch (err) {
      console.error('[ChannelsPanel] save error:', err);
      toast.error('Não foi possível alcançar o servidor');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(channel: Channel) {
    setDeleting(channel.id);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao remover canal');
        return;
      }
      toast.success('Canal removido');
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
    } catch (err) {
      console.error('[ChannelsPanel] delete error:', err);
      toast.error('Não foi possível alcançar o servidor');
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Canais"
        description={
          <>
            Todos os números de WhatsApp pelos quais este workspace envia e
            recebe mensagens — via Cloud API oficial e Evolution API. Adicione
            quantos números quiser; misture provedores livremente.
          </>
        }
        action={
          <RequireRole min="admin">
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Adicionar número Evolution
            </Button>
          </RequireRole>
        }
      />

      {channels.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Radio className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">Nenhum canal ainda.</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Adicione um número Evolution aqui, ou configure um número Cloud API na aba{' '}
              <span className="text-foreground">WhatsApp</span>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {channels.map((c) => {
                const connected = c.status === 'connected';
                return (
                  <li
                    key={c.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          {c.display_name || c.phone_e164 || c.identifier}
                        </span>
                        <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                          {PROVIDER_LABEL[c.provider]}
                        </Badge>
                        <Badge
                          className={`text-[10px] tracking-wide uppercase ${
                            connected
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'border-border bg-muted text-muted-foreground'
                          }`}
                        >
                          {connected ? 'Conectado' : c.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {c.provider === 'evolution' ? 'instance: ' : 'phone_number_id: '}
                        {c.identifier}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {c.capabilities.templates && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px]">
                            Templates
                          </Badge>
                        )}
                        {c.capabilities.freeform && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px]">
                            Texto livre
                          </Badge>
                        )}
                        {c.provider === 'cloud' && (
                          <span className="text-muted-foreground text-[10px]">
                            Gerenciado na aba WhatsApp
                          </span>
                        )}
                      </div>
                    </div>
                    <RequireRole min="admin">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive self-start sm:self-center"
                        disabled={deleting === c.id}
                        onClick={() => handleDelete(c)}
                      >
                        {deleting === c.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </RequireRole>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {!canEditSettings && channels.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Somente administradores podem adicionar ou remover canais.
        </p>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar número Evolution</DialogTitle>
            <DialogDescription>
              Conecte um número rodando no seu servidor Evolution API. A chave
              de API é criptografada no servidor e nunca exibida novamente.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ch-name">Nome de exibição</Label>
              <Input
                id="ch-name"
                placeholder="ex: Linha de vendas"
                value={form.display_name}
                onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-instance">Nome da instância</Label>
              <Input
                id="ch-instance"
                placeholder="ex: imobquest"
                value={form.instance}
                onChange={(e) => setForm((f) => ({ ...f, instance: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-base">URL do servidor</Label>
              <Input
                id="ch-base"
                placeholder="https://evolution.exemplo.com"
                value={form.base_url}
                onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-key">Chave de API</Label>
              <Input
                id="ch-key"
                type="password"
                placeholder="Chave de API da instância"
                value={form.api_key}
                onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-phone">
                Telefone <span className="text-muted-foreground">(opcional)</span>
              </Label>
              <Input
                id="ch-phone"
                placeholder="+5511999999999"
                value={form.phone_e164}
                onChange={(e) => setForm((f) => ({ ...f, phone_e164: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleAddEvolution} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Salvar número
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
