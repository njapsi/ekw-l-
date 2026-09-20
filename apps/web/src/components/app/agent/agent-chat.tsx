'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentRunTimeline, Button, Input, type AgentTimelineStep } from '@growth-agent/ui';
import { type AgentBlocks, MessageBlocks } from './message-blocks';

const STAGE_LABEL: Record<string, string> = {
  gathering: 'Reading your connected data',
  planning: 'Choosing specialists',
  planned: 'Plan ready',
  synthesizing: 'Combining the results',
  writing: 'Writing the answer',
};

interface ChatMessage {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  blocks: AgentBlocks | null;
  streaming?: boolean;
}

const EXAMPLES = [
  'Why is my YouTube channel losing momentum?',
  'What should I post this week?',
  'How can I make more money from my existing audience?',
  'What are the five biggest SEO problems?',
  'Give me a 30-day growth plan.',
  'Turn my YouTube video into TikTok content.',
];

export function AgentChat({
  conversationId,
  initialMessages,
}: {
  conversationId?: string;
  initialMessages: ChatMessage[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [timeline, setTimeline] = useState<AgentTimelineStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const convoRef = useRef(conversationId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, timeline]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setBusy(true);
    setInput('');
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'USER',
      content: message,
      blocks: null,
    };
    const asstId = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      userMsg,
      { id: asstId, role: 'ASSISTANT', content: '', blocks: null, streaming: true },
    ]);
    setTimeline([{ id: 'start', label: 'Starting…', status: 'active' }]);

    try {
      const res = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId: convoRef.current }),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let newConversationId: string | undefined;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as
            | { type: 'status'; stage: string; detail?: string }
            | { type: 'token'; text: string }
            | {
                type: 'done';
                conversationId: string;
                messageId: string;
                title: string;
                blocks: AgentBlocks;
              }
            | { type: 'error'; message: string };

          if (ev.type === 'status') {
            // 'running' fires once per specialist capability with a real,
            // distinct detail (e.g. "Running SEO Auditor") — each becomes its
            // own step rather than overwriting the last, since several can
            // run in one turn. Every other stage is a one-time milestone.
            const label =
              ev.stage === 'running'
                ? (ev.detail ?? 'Running a specialist')
                : (STAGE_LABEL[ev.stage] ?? ev.detail ?? ev.stage);
            const id = ev.stage === 'running' ? `running-${label}` : ev.stage;
            setTimeline((t) => {
              const done = t.map((s) => ({ ...s, status: 'done' as const }));
              if (done.some((s) => s.id === id)) return done;
              return [...done, { id, label, status: 'active' as const }];
            });
          } else if (ev.type === 'token') {
            setMessages((m) =>
              m.map((x) => (x.id === asstId ? { ...x, content: x.content + ev.text } : x)),
            );
          } else if (ev.type === 'done') {
            newConversationId = ev.conversationId;
            setTimeline((t) => t.map((s) => ({ ...s, status: 'done' as const })));
            setMessages((m) =>
              m.map((x) =>
                x.id === asstId
                  ? { ...x, id: ev.messageId, blocks: ev.blocks, streaming: false }
                  : x,
              ),
            );
          } else if (ev.type === 'error') {
            setError(ev.message);
            setTimeline((t) =>
              t.map((s) => (s.status === 'active' ? { ...s, status: 'error' as const } : s)),
            );
            setMessages((m) => m.filter((x) => x.id !== asstId));
          }
        }
      }

      if (newConversationId && !convoRef.current) {
        convoRef.current = newConversationId;
        router.replace(`/app/agent/${newConversationId}`);
        router.refresh();
      } else {
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The agent hit an error.');
      setMessages((m) => m.filter((x) => x.id !== asstId));
    } finally {
      setBusy(false);
      setTimeline([]);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="text-muted-foreground space-y-3 text-sm">
            <p>
              Ask the Growth Agent to reason over your connected YouTube, TikTok and SEO data. It
              plans which specialists to use, gathers evidence, and returns prioritized, explainable
              actions. It never changes an external account.
            </p>
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="border-border hover:bg-muted rounded border px-2 py-1 text-xs"
                  onClick={() => void send(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((m) => (
          <div key={m.id} className={m.role === 'USER' ? 'flex justify-end' : ''}>
            <div
              className={
                m.role === 'USER'
                  ? 'bg-primary text-primary-foreground max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm'
                  : 'bg-card w-full rounded-lg border p-3'
              }
            >
              {m.role === 'ASSISTANT' ? (
                <>
                  <div className="whitespace-pre-wrap text-sm">
                    {m.content || (m.streaming ? '…' : '')}
                  </div>
                  {m.blocks ? (
                    <MessageBlocks blocks={m.blocks} conversationId={convoRef.current} />
                  ) : null}
                </>
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}

        {timeline.length > 0 ? (
          <div role="status" aria-live="polite" className="bg-card rounded-lg border p-3">
            <AgentRunTimeline steps={timeline} />
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {error ? (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {error}
        </p>
      ) : null}

      <form
        className="mt-3 flex items-end gap-2 border-t pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the Growth Agent…"
          disabled={busy}
          autoFocus
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Working…' : 'Send'}
        </Button>
      </form>
    </div>
  );
}
