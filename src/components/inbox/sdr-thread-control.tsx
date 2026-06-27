"use client";

// ============================================================
// SdrThreadControl — inbox header control for the AI SDR.
//
// Shows whether the bot is driving this thread and lets an agent
// take over (handoff) or hand it back. Only renders when the SDR is
// actually wired to the conversation (active/handoff) — a thread that
// never had an SDR shows nothing. Talks to PATCH /api/sdr/conversation/[id].
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { Bot, Loader2, UserRound } from "lucide-react";
import type { SdrStatus } from "@/types";

interface SdrThreadControlProps {
  conversationId: string;
  sdrStatus: SdrStatus | undefined;
  /** Campaign link — required to (re)activate the SDR. */
  broadcastId: string | null | undefined;
  /** Bubble the new status up so the parent can update its state. */
  onChange: (status: SdrStatus) => void;
}

export function SdrThreadControl({
  conversationId,
  sdrStatus,
  broadcastId,
  onChange,
}: SdrThreadControlProps) {
  const [busy, setBusy] = useState(false);

  // Nothing to show unless the SDR is (or was) active on this thread.
  if (sdrStatus !== "active" && sdrStatus !== "handoff") return null;

  async function patch(next: SdrStatus) {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { sdr_status: next };
      // Reactivating needs the campaign link so the worker finds the config.
      if (next === "active") body.broadcast_id = broadcastId;
      const res = await fetch(`/api/sdr/conversation/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Falha ao atualizar o SDR");
        return;
      }
      onChange(next);
      toast.success(
        next === "handoff" ? "Você assumiu a conversa" : "SDR reativado",
      );
    } catch {
      toast.error("Não foi possível alcançar o servidor");
    } finally {
      setBusy(false);
    }
  }

  if (sdrStatus === "active") {
    return (
      <button
        type="button"
        onClick={() => patch("handoff")}
        disabled={busy}
        title="O robô está respondendo. Clique para assumir a conversa."
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-primary transition-colors hover:bg-muted disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )}
        SDR ativo · Assumir
      </button>
    );
  }

  // sdrStatus === 'handoff' — a human is in control.
  const canReactivate = !!broadcastId;
  return (
    <button
      type="button"
      onClick={() => canReactivate && patch("active")}
      disabled={busy || !canReactivate}
      title={
        canReactivate
          ? "Você assumiu. Clique para devolver a conversa ao SDR."
          : "Você assumiu esta conversa."
      }
      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <UserRound className="h-3.5 w-3.5" />
      )}
      {canReactivate ? "Humano · Reativar SDR" : "Humano no controle"}
    </button>
  );
}
